/** Install self-contained, already authenticated component archives and edit only updater-owned profile rows. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { gt, satisfies, valid, validRange } from 'semver';
import { list, extract, type ReadEntry } from 'tar';
import { isScalar, isSeq, parseDocument, visit, type YAMLMap } from 'yaml';
import { z } from 'zod';

/** Signed component metadata; a component id never names an existing DSH core row. */
export interface ComponentDescriptor {
  id: string;
  packageName: string;
  version: string;
  entry: string;
  kind: 'component';
  activation: 'hot' | 'restart';
  requiresDshVersion: string;
}

/** Resource ceilings apply before any archive content becomes visible to the Loader. */
export interface ComponentLimits {
  archiveBytes: number;
  expandedBytes: number;
  entries: number;
  patchBytes: number;
}

const DEFAULT_LIMITS: ComponentLimits = { archiveBytes: 64 * 1024 * 1024, expandedBytes: 256 * 1024 * 1024, entries: 10_000, patchBytes: 2 * 1024 * 1024 };
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const revision = (value: string) => `sha256-${sha256(value)}`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Immutable installation receipt. Installation does not establish that the Loader activated the plugin. */
export interface InstalledComponent {
  status: 'installed';
  descriptor: ComponentDescriptor;
  directory: string;
  entryUrl: string;
  archiveSha256: string;
}

interface StoredComponent extends InstalledComponent { fileHashes: Record<string, string> }

const operationSchema = z.object({
  before: z.string().max(DEFAULT_LIMITS.patchBytes),
  after: z.string().max(DEFAULT_LIMITS.patchBytes),
  afterRevision: z.string().regex(/^sha256-[a-f0-9]{64}$/u),
  id: z.string().regex(ID), version: z.string().refine(value => valid(value) === value),
  activation: z.enum(['hot', 'restart']),
  state: z.enum(['staged', 'applied', 'switching', 'awaiting-health', 'completed', 'rolled-back', 'blocked']),
  failure: z.string().optional(),
  direction: z.enum(['update', 'rollback']).optional(),
  activatedAt: z.string().datetime().optional(),
  observedHostPid: z.number().int().positive().optional(),
  observedRunId: z.string().min(1).optional(),
});
type ComponentOperation = z.infer<typeof operationSchema>;

/** Persisted progress of a user-approved component change. */
export interface ComponentOperationStatus {
  token: string;
  id: string;
  version: string;
  state: ComponentOperation['state'];
  activation: 'hot' | 'restart';
  observedHostPid?: number;
  observedRunId?: string;
  failure?: string;
}

const OPERATION_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function readOperation(root: string, token: string): Promise<ComponentOperation> {
  if (!OPERATION_TOKEN.test(token)) throw new Error('Invalid component operation token');
  return operationSchema.parse(JSON.parse((await regularFile(join(root, 'operations', `${token}.json`), DEFAULT_LIMITS.patchBytes * 8)).toString('utf8')));
}

/** Read durable progress without creating update directories or exposing profile content.
 * @param dshHome - selected Host home.
 * @returns approved operations in deterministic token order; invalid records reject the observation.
 */
export async function listComponentOperations(dshHome: string): Promise<ComponentOperationStatus[]> {
  if (!isAbsolute(dshHome) || resolve(dshHome) !== dshHome || parse(dshHome).root === dshHome) throw new Error('DSH home must be an absolute normalized directory below the filesystem root');
  const root = join(dshHome, 'clawmaster-updates');
  const paths = [dshHome, root, join(root, 'operations')];
  for (const path of paths) {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Component state directories must not be symbolic links');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  const rows: ComponentOperationStatus[] = [];
  for (const name of (await readdir(join(root, 'operations'))).sort()) {
    if (!name.endsWith('.json')) continue;
    const token = name.slice(0, -5);
    const record = await readOperation(root, token);
    rows.push({ token, id: record.id, version: record.version, state: record.state, activation: record.activation,
      ...(record.observedHostPid === undefined ? {} : { observedHostPid: record.observedHostPid }),
      ...(record.observedRunId === undefined ? {} : { observedRunId: record.observedRunId }),
      ...(record.failure === undefined ? {} : { failure: record.failure }) });
  }
  return rows;
}

/** A profile edit awaits Loader observation or a Host restart; it never reports itself active. */
export interface ComponentActivation {
  status: 'activation-pending' | 'restart-required';
  rowId: string;
  entryUrl: string;
  patchRevision: string;
  rollbackToken: string;
}

function limits(input: Partial<ComponentLimits> | undefined): ComponentLimits {
  const result = { ...DEFAULT_LIMITS, ...input };
  for (const value of Object.values(result)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Component limits must be positive integers');
  return result;
}

function safeRelative(value: string): string {
  const name = value.replace(/^\.\//, '');
  if (!name || name.length > 512 || name.includes('\\') || name.startsWith('/') || /[\u0000-\u001f\u007f:]/u.test(name)
    || name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Component archive contains an unsafe path');
  }
  return name;
}

function validateDescriptor(value: ComponentDescriptor): void {
  if (value.kind !== 'component' || !ID.test(value.id) || !PACKAGE_NAME.test(value.packageName)
    || valid(value.version) !== value.version || !validRange(value.requiresDshVersion)
    || !['hot', 'restart'].includes(value.activation)) throw new Error('Invalid component descriptor');
  if (!/\.(?:mjs|js)$/.test(safeRelative(value.entry))) throw new Error('Component entry must be an ESM JavaScript file');
  if (value.id === 'updates' && value.activation !== 'restart') throw new Error('The updater component requires a restart');
}

async function directory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Component state directories must not be symbolic links');
}

async function stateRoot(dshHome: string): Promise<string> {
  if (!isAbsolute(dshHome) || resolve(dshHome) !== dshHome || parse(dshHome).root === dshHome) throw new Error('DSH home must be an absolute normalized directory below the filesystem root');
  await directory(dshHome);
  const root = join(dshHome, 'clawmaster-updates');
  await directory(root);
  await directory(join(root, 'components'));
  await directory(join(root, 'operations'));
  return root;
}

async function regularFile(path: string, maximum: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error('Component input must be a bounded regular file');
  const bytes = await readFile(path);
  if (bytes.length > maximum) throw new Error('Component input exceeds its size limit');
  return bytes;
}

async function optionalPatch(path: string, maximum: number): Promise<string> {
  try { return (await regularFile(path, maximum)).toString('utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}

function inventory(ceilings: ComponentLimits): { names: Set<string>; files: Set<string>; onReadEntry: (entry: ReadEntry) => void } {
  const names = new Set<string>();
  const files = new Set<string>();
  const folded = new Set<string>();
  let bytes = 0;
  return { names, files, onReadEntry(entry) {
    // ReadEntry normalizes Windows separators; its header retains the archive's original path.
    safeRelative(entry.header.path!.replace(/\/$/, ''));
    const name = safeRelative(entry.path.replace(/\/$/, ''));
    if ((name !== 'package' && !name.startsWith('package/')) || !['File', 'Directory'].includes(entry.type)) {
      throw new Error('Components permit only regular npm package files and directories');
    }
    if (folded.has(name.toLowerCase())) throw new Error('Component archive contains duplicate or case-conflicting paths');
    folded.add(name.toLowerCase());
    names.add(name);
    if (entry.type === 'File') files.add(name);
    bytes += entry.size;
    if (!Number.isSafeInteger(bytes) || bytes > ceilings.expandedBytes || names.size > ceilings.entries) throw new Error('Component archive exceeds its extraction limits');
  } };
}

async function parseArchive(archive: Buffer, target: NodeJS.WritableStream, maximum: number): Promise<void> {
  let expanded = 0;
  const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    expanded += chunk.length;
    callback(expanded > maximum ? new Error('Component archive exceeds its extraction limits') : null, chunk);
  } });
  await pipeline(Readable.from([archive]), createGunzip(), bounded, target);
}

interface NpmManifest {
  name?: string;
  version?: string;
  type?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

async function packageManifest(path: string): Promise<NpmManifest> {
  return JSON.parse((await regularFile(join(path, 'package.json'), 1024 * 1024)).toString('utf8')) as NpmManifest;
}

async function verifyClosure(packageRoot: string, supplied: Record<string, string>): Promise<void> {
  const visited = new Set<string>();
  async function verify(path: string): Promise<void> {
    if (visited.has(path)) return;
    visited.add(path);
    const manifest = await packageManifest(path);
    for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (!PACKAGE_NAME.test(name) || typeof range !== 'string' || !validRange(range)) throw new Error('Component dependencies must use package names and SemVer ranges');
      let candidate = path;
      let found: string | undefined;
      while (candidate === packageRoot || candidate.startsWith(`${packageRoot}/`) || candidate.startsWith(`${packageRoot}\\`)) {
        const dependency = join(candidate, 'node_modules', name);
        try {
          const info = await lstat(join(dependency, 'package.json'));
          if (info.isFile() && !info.isSymbolicLink()) { found = dependency; break; }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (candidate === packageRoot) break;
        candidate = dirname(candidate);
      }
      if (!found) throw new Error(`Component is not self-contained: missing ${name}`);
      const installed = await packageManifest(found);
      if (typeof installed.version !== 'string' || !satisfies(installed.version, range, { includePrerelease: true })) throw new Error(`Bundled dependency version is incompatible: ${name}`);
      await verify(found);
    }
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[name]?.optional === true && supplied[name] === undefined) continue;
      if ((!name.startsWith('@deepseek-ai/dsh-') && name !== '@deepseek-ai/cordis') || typeof range !== 'string'
        || !validRange(range) || !supplied[name] || !satisfies(supplied[name], range, { includePrerelease: true })) {
        throw new Error(`Host peer dependency is unavailable or incompatible: ${name}`);
      }
    }
  }
  await verify(packageRoot);
}

/**
 * Persist an already signature-verified archive without executing it or npm lifecycle scripts.
 * The caller supplies the selected Host's exact DSH and shared package versions.
 * A per-component process lock rejects versions below any verified installation in the selected home.
 * @param options - authenticated archive, descriptor and selected Host facts.
 * @returns an immutable installation receipt; activation is a separate confirmed operation.
 */
export async function installComponent(options: {
  archivePath: string; descriptor: ComponentDescriptor; dshHome: string; dshVersion: string;
  providedPackages?: Record<string, string>; limits?: Partial<ComponentLimits>;
}): Promise<InstalledComponent> {
  validateDescriptor(options.descriptor);
  if (valid(options.dshVersion) !== options.dshVersion || !satisfies(options.dshVersion, options.descriptor.requiresDshVersion, { includePrerelease: true })) {
    throw new Error('Component requires a different DSH version');
  }
  const ceilings = limits(options.limits);
  const archive = await regularFile(options.archivePath, ceilings.archiveBytes);
  const root = await stateRoot(options.dshHome);
  const owner = join(root, 'components', options.descriptor.id);
  await directory(owner);
  return withFileLock(join(owner, 'installation'), async () => {
    await rejectInstalledDowngrade(options.dshHome, options.descriptor.id, options.descriptor.version);
    const destination = join(owner, options.descriptor.version);
    const receipt: InstalledComponent = { status: 'installed', descriptor: options.descriptor, directory: destination,
      entryUrl: pathToFileURL(join(destination, 'package', safeRelative(options.descriptor.entry))).href, archiveSha256: sha256(archive) };
    let exists = false;
    try { await lstat(destination); exists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (exists) {
      const current = await installed(root, options.descriptor.id, options.descriptor.version);
      if (json(current) !== json(receipt)) throw new Error('An immutable component version already has different content');
      return receipt;
    }
    const stage = await mkdtemp(join(owner, '.stage-'));
    try {
      const checked = inventory(ceilings);
      const parser = list({ strict: true, maxMetaEntrySize: 1024 * 1024 });
      parser.on('entry', (entry: ReadEntry) => {
        try { checked.onReadEntry(entry); }
        catch (error) { parser.abort(error as Error); }
      });
      await parseArchive(archive, parser, ceilings.expandedBytes);
      if (!checked.names.has(`package/${safeRelative(options.descriptor.entry)}`) || !checked.names.has('package/package.json')) throw new Error('Component archive is missing its entry or package manifest');
      await parseArchive(archive, extract({ cwd: stage, strict: true, preservePaths: false, noChmod: true,
        noMtime: true, maxDepth: 64, maxMetaEntrySize: 1024 * 1024, filter: path => checked.names.has(path.replace(/\/$/, '')) }), ceilings.expandedBytes);
      const manifest = await packageManifest(join(stage, 'package'));
      if (manifest.name !== options.descriptor.packageName || manifest.version !== options.descriptor.version || manifest.type !== 'module') throw new Error('Component package identity differs from the signed descriptor');
      await regularFile(join(stage, 'package', safeRelative(options.descriptor.entry)), ceilings.expandedBytes);
      await verifyClosure(join(stage, 'package'), options.providedPackages ?? {});
      const fileHashes: Record<string, string> = {};
      for (const name of checked.files) fileHashes[name] = sha256(await regularFile(join(stage, name), ceilings.expandedBytes));
      await writeFile(join(stage, 'receipt.json'), json({ ...receipt, fileHashes }), { flag: 'wx', mode: 0o600 });
      await rename(stage, destination);
      return receipt;
    } finally { await rm(stage, { recursive: true, force: true }); }
  });
}

async function patchPath(dshHome: string): Promise<string> {
  await directory(join(dshHome, 'profiles'));
  await directory(join(dshHome, 'profiles', 'web'));
  return join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
}

/** @param dshHome - selected Host home. @returns the revision required for a subsequent confirmed profile edit. */
export async function readComponentPatchRevision(dshHome: string): Promise<string> {
  if (!isAbsolute(dshHome) || resolve(dshHome) !== dshHome || parse(dshHome).root === dshHome) throw new Error('DSH home must be an absolute normalized directory below the filesystem root');
  for (const path of [dshHome, join(dshHome, 'profiles'), join(dshHome, 'profiles', 'web')]) {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Profile directories must not be symbolic links');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return revision(''); throw error; }
  }
  return revision(await optionalPatch(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), DEFAULT_LIMITS.patchBytes));
}

/**
 * Inspect verified installed versions without creating updater state.
 * @param dshHome - selected Host home.
 * @param id - updater-owned component id.
 * @returns the greatest installed SemVer, including staged versions, or null when none exist; corrupt installations reject.
 */
export async function highestInstalledComponentVersion(dshHome: string, id: string): Promise<string | null> {
  if (!ID.test(id)) throw new Error('Invalid installed component identity');
  if (!isAbsolute(dshHome) || resolve(dshHome) !== dshHome || parse(dshHome).root === dshHome) throw new Error('DSH home must be an absolute normalized directory below the filesystem root');
  const root = join(dshHome, 'clawmaster-updates');
  const owner = join(root, 'components', id);
  for (const path of [dshHome, root, join(root, 'components'), owner]) {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Installed component directories must not be symbolic links');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  let highest: string | null = null;
  for (const entry of await readdir(owner, { withFileTypes: true })) {
    if (valid(entry.name) !== entry.name) continue;
    await installed(root, id, entry.name);
    if (highest === null || gt(entry.name, highest)) highest = entry.name;
  }
  return highest;
}

async function rejectInstalledDowngrade(dshHome: string, id: string, version: string): Promise<void> {
  const highest = await highestInstalledComponentVersion(dshHome, id);
  if (highest !== null && gt(highest, version)) throw new Error('Component update would downgrade a verified installed version; use explicit rollback instead');
}

async function installed(root: string, id: string, version: string): Promise<InstalledComponent> {
  if (!ID.test(id) || valid(version) !== version) throw new Error('Invalid installed component identity');
  const path = join(root, 'components', id, version);
  for (const directory of [join(root, 'components', id), path]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Installed component directories must not be symbolic links');
  }
  const value = JSON.parse((await regularFile(join(path, 'receipt.json'), 16 * 1024 * 1024)).toString('utf8')) as StoredComponent;
  validateDescriptor(value.descriptor);
  if (value.descriptor.id !== id || value.descriptor.version !== version || value.directory !== path
    || value.entryUrl !== pathToFileURL(join(path, 'package', safeRelative(value.descriptor.entry))).href) throw new Error('Invalid installed component receipt');
  if (!value.fileHashes || !Object.hasOwn(value.fileHashes, `package/${safeRelative(value.descriptor.entry)}`)) throw new Error('Installed component has no entry digest');
  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      const name = relative(path, child).split('\\').join('/');
      if (name === 'receipt.json' && entry.isFile()) continue;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())
        || (entry.isFile() && !Object.hasOwn(value.fileHashes, name))) throw new Error('Installed component contains an unverified file');
      if (entry.isDirectory()) await inspect(child);
    }
  }
  await inspect(path);
  for (const [name, digest] of Object.entries(value.fileHashes)) {
    if (!safeRelative(name).startsWith('package/') || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid installed file digest');
    let parent = dirname(join(path, name));
    while (parent !== path) {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Installed component directories must not be symbolic links');
      parent = dirname(parent);
    }
    if (sha256(await regularFile(join(path, name), DEFAULT_LIMITS.expandedBytes)) !== digest) throw new Error('Installed component file digest differs from its verified archive');
  }
  const { fileHashes: _hashes, ...receipt } = value;
  return receipt;
}

async function nextPatch(text: string, root: string, target: InstalledComponent): Promise<string> {
  const doc = parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length || (doc.contents !== null && !isSeq(doc.contents))) throw new Error('The web profile patch must be a valid YAML sequence');
  const rowId = `clawmaster-update-component-${target.descriptor.id}`;
  const matches: YAMLMap[] = [];
  visit(doc, { Map(_key, node) { if (node.get('id') === rowId) matches.push(node); } });
  if (matches.length > 1) throw new Error('The updater-owned profile row is duplicated');
  const node = matches[0];
  if (!node) {
    if (isSeq(doc.contents) && doc.contents.flow && doc.contents.range) {
      const at = doc.contents.range[1] - 1;
      const prefix = text.slice(0, at);
      const comma = doc.contents.items.length > 0 && !prefix.trimEnd().endsWith(',') ? ',' : '';
      return `${prefix}${comma}${JSON.stringify({ insert: [{ id: rowId, name: target.entryUrl }] })}${text.slice(at)}`;
    }
    const at = doc.range?.[1] ?? text.length;
    const prefix = text.slice(0, at);
    return `${prefix}${prefix && !prefix.endsWith('\n') ? '\n' : ''}- insert:\n    - id: ${rowId}\n      name: ${JSON.stringify(target.entryUrl)}\n${text.slice(at)}`;
  }
  const name = node.get('name', true);
  if (node.items.length !== 2 || !isScalar(name) || typeof name.value !== 'string' || !name.range) throw new Error('The updater-owned row was edited outside the updater');
  await verifyOwnedEntry(root, target.descriptor.id, name.value);
  return `${text.slice(0, name.range[0])}${JSON.stringify(target.entryUrl)}${text.slice(name.range[1])}`;
}

async function verifyOwnedEntry(root: string, id: string, name: string): Promise<void> {
  let oldPath: string;
  try { oldPath = fileURLToPath(name); } catch { throw new Error('Existing profile row does not belong to this updater'); }
  const version = relative(join(root, 'components', id), oldPath).split(/[\\/]/)[0] ?? '';
  const previous = await installed(root, id, version);
  if (name !== previous.entryUrl) throw new Error('Existing profile row does not belong to this updater');
}

async function verifyRollbackEntry(root: string, id: string, text: string): Promise<void> {
  const doc = parseDocument(text);
  if (doc.errors.length || (doc.contents !== null && !isSeq(doc.contents))) throw new Error('Invalid rollback profile document');
  const matches: YAMLMap[] = [];
  visit(doc, { Map(_key, node) { if (node.get('id') === `clawmaster-update-component-${id}`) matches.push(node); } });
  if (matches.length > 1) throw new Error('The rollback component row is duplicated');
  const previous = matches[0];
  if (!previous) return;
  const name = previous.get('name');
  if (previous.items.length !== 2 || typeof name !== 'string') throw new Error('Invalid rollback component row');
  await verifyOwnedEntry(root, id, name);
}

function rejectUpdaterRows(text: string, componentRoot: string): void {
  const doc = parseDocument(text);
  if (doc.errors.length || (doc.contents !== null && !isSeq(doc.contents))) throw new Error('Updater bootstrap requires valid user patch sequences');
  const ownedUrl = pathToFileURL(`${componentRoot}/`).href;
  visit(doc, { Map(_key, node) {
    const name = node.get('name');
    if (node.get('id') === 'clawmaster-update-component-updates'
      || name === '@clawmaster/dsh-updates' || (typeof name === 'string' && name.startsWith(ownedUrl))) {
      throw new Error('Updater bootstrap is first-install only; an updater row already exists');
    }
  } });
}

async function initialUpdaterState(dshHome: string, root: string, profileText: string): Promise<string> {
  const homeText = await optionalPatch(join(dshHome, 'cordis.patch.yml'), DEFAULT_LIMITS.patchBytes);
  const manifestText = await optionalPatch(join(dshHome, 'profiles', 'web', 'package.json'), DEFAULT_LIMITS.patchBytes);
  const componentRoot = join(root, 'components', 'updates');
  rejectUpdaterRows(profileText, componentRoot);
  rejectUpdaterRows(homeText, componentRoot);
  if (manifestText) {
    const manifest = JSON.parse(manifestText) as { dependencies?: Record<string, unknown>; dsh?: { profile?: { bundles?: unknown[] } } };
    if (Object.hasOwn(manifest.dependencies ?? {}, '@clawmaster/dsh-updates')
      || manifest.dsh?.profile?.bundles?.includes('@clawmaster/dsh-updates')) {
      throw new Error('Updater bootstrap is first-install only; the profile already declares the updater');
    }
  }
  return revision(json([homeText, manifestText]));
}

interface ActivationOptions {
  dshHome: string;
  id: string;
  version: string;
  expectedPatchRevision: string;
  confirmed: boolean;
}

/**
 * Edit one updater-owned row after user confirmation and a matching patch revision.
 * Profile and component locks reject candidates below a version installed by another process sharing this home.
 * @param options - selected component, user confirmation and the revision shown before confirmation.
 * Restart-only components are staged without editing the watched patch; a stopped-Host installer must apply them later.
 * @returns pending activation state plus a revision-checked rollback token; Loader success must be observed separately.
 */
export async function activateComponent(options: { dshHome: string; id: string; version: string; expectedPatchRevision: string; confirmed: boolean }): Promise<ComponentActivation> {
  return activateInstalled(options, false);
}

/**
 * Mount only the first updater package; existing rows and declared updater bundles always reject this operation.
 * The version check and profile write share the component installation lock across processes.
 * @param options - selected home, installed updater version and user-confirmed profile revision.
 * @returns a pending Loader observation; this operation never replaces an existing updater.
 */
export async function mountFirstUpdaterComponent(options: Omit<ActivationOptions, 'id'>): Promise<ComponentActivation> {
  return activateInstalled({ ...options, id: 'updates' }, true);
}

async function assertDesktopHostStopped(dshHome: string): Promise<void> {
  const path = join(dshHome, 'desktop', 'current-runtime.json');
  const desktop = await lstat(dirname(path));
  if (!desktop.isDirectory() || desktop.isSymbolicLink()) throw new Error('Desktop runtime directory must not be a symbolic link');
  const record = z.object({ schemaVersion: z.literal(1), hostPid: z.number().int().positive(), runId: z.string().min(1), status: z.enum(['ready', 'stopped']) })
    .parse(JSON.parse((await regularFile(path, 1024 * 1024)).toString('utf8')));
  try { process.kill(record.hostPid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw new Error('Cannot verify that the desktop Host has stopped', { cause: error });
  }
  throw new Error('The desktop Host is still running; component maintenance requires its exit');
}

/** Apply approved updater changes before the desktop starts its Host, or recover an unconfirmed switch.
 * The desktop must serialize its own start/stop lifecycle around this finite operation.
 * A previous switch without a matching loaded-plugin receipt is restored before another attempt.
 * @param dshHome - selected desktop home with a previously published Host identity.
 * @returns per-operation outcomes; no result claims that a newly selected plugin has loaded.
 */
export async function maintainRestartComponents(dshHome: string): Promise<ComponentOperationStatus[]> {
  const pending = (await listComponentOperations(dshHome)).filter(record => record.id === 'updates'
    && record.activation === 'restart' && ['staged', 'switching', 'awaiting-health'].includes(record.state));
  if (pending.length === 0) return [];
  await assertDesktopHostStopped(dshHome);
  const root = await stateRoot(dshHome);
  const path = await patchPath(dshHome);
  const changed: ComponentOperationStatus[] = [];
  await withFileLock(path, async () => {
    await assertDesktopHostStopped(dshHome);
    const owner = join(root, 'components', 'updates');
    const info = await lstat(owner);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Installed component directories must not be symbolic links');
    await withFileLock(join(owner, 'installation'), async () => {
      for (const candidate of pending) {
        const record = await readOperation(root, candidate.token);
        const recordPath = join(root, 'operations', `${candidate.token}.json`);
        if (record.id !== 'updates' || record.activation !== 'restart') throw new Error('Restart operation identity changed');
        const current = await optionalPatch(path, DEFAULT_LIMITS.patchBytes);
        if (record.state === 'switching' || record.state === 'awaiting-health') {
          if (current !== record.before && current !== record.after) throw new Error('Unconfirmed update conflicts with user profile changes; manual recovery is required');
          await verifyRollbackEntry(root, record.id, record.before);
          if (current === record.after) await writeFileAtomic(path, record.before, { mode: 0o600, dirMode: 0o700 });
          await writeFileAtomic(recordPath, json({ ...record, state: 'rolled-back', afterRevision: revision(record.before) }), { mode: 0o600, dirMode: 0o700 });
          changed.push({ ...candidate, state: 'rolled-back' });
          continue;
        }
        if (record.state !== 'staged') continue;
        try {
          if (revision(current) !== record.afterRevision || current !== record.before) throw new Error('Staged update conflicts with newer profile changes; inspect and approve a fresh update');
          const target = await installed(root, record.id, record.version);
          if (target.descriptor.packageName !== '@clawmaster/dsh-updates' || target.descriptor.activation !== 'restart') throw new Error('Restart maintenance accepts only the verified updater');
          if (await nextPatch(record.before, root, target) !== record.after) throw new Error('Staged profile differs from the approved component');
        } catch (error) {
          const failure = error instanceof Error ? error.message : 'Component verification failed';
          await writeFileAtomic(recordPath, json({ ...record, state: 'blocked', failure }), { mode: 0o600, dirMode: 0o700 });
          changed.push({ ...candidate, state: 'blocked', failure });
          continue;
        }
        const switching = { ...record, state: 'switching' as const, afterRevision: revision(record.after) };
        await writeFileAtomic(recordPath, json(switching), { mode: 0o600, dirMode: 0o700 });
        await writeFileAtomic(path, record.after, { mode: 0o600, dirMode: 0o700 });
        await writeFileAtomic(recordPath, json({ ...switching, state: 'awaiting-health' }), { mode: 0o600, dirMode: 0o700 });
        changed.push({ ...candidate, state: 'awaiting-health' });
      }
    });
  });
  return changed;
}

/** Confirm the exact updater entry only after its Host registrations succeed.
 * @param options - executing module URL and actual process identity, supplied by the loaded plugin.
 * @returns confirmed operation tokens; unrelated or already-complete operations remain untouched.
 */
export async function confirmComponentHealth(options: { dshHome: string; entryUrl: string; hostPid: number; runId: string }): Promise<string[]> {
  if (options.hostPid !== process.pid || !options.runId || options.runId !== process.env.CLAWMASTER_RUNTIME_RUN_ID) throw new Error('Health confirmation requires the actual executing desktop Host');
  const operations = await listComponentOperations(options.dshHome);
  const candidates = operations.filter(operation => operation.id === 'updates' && operation.state === 'awaiting-health');
  if (!candidates.length) return [];
  const root = await stateRoot(options.dshHome);
  const path = await patchPath(options.dshHome);
  return withFileLock(path, async () => {
    const confirmed: string[] = [];
    for (const candidate of candidates) {
      const record = await readOperation(root, candidate.token);
      if (record.state !== 'awaiting-health') continue;
      const target = await installed(root, record.id, record.version);
      if (target.entryUrl !== options.entryUrl) continue;
      if (await optionalPatch(path, DEFAULT_LIMITS.patchBytes) !== record.after) throw new Error('Loaded updater profile differs from its approved activation');
      await writeFileAtomic(join(root, 'operations', `${candidate.token}.json`), json({ ...record, state: 'completed',
        activatedAt: new Date().toISOString(), observedHostPid: process.pid, observedRunId: options.runId }), { mode: 0o600, dirMode: 0o700 });
      confirmed.push(candidate.token);
    }
    return confirmed;
  });
}

async function activateInstalled(options: ActivationOptions, firstUpdater: boolean): Promise<ComponentActivation> {
  if (!options.confirmed) throw new Error('Component activation requires explicit confirmation');
  if (!ID.test(options.id) || valid(options.version) !== options.version) throw new Error('Invalid installed component identity');
  const root = await stateRoot(options.dshHome);
  const path = await patchPath(options.dshHome);
  const owner = join(root, 'components', options.id);
  const info = await lstat(owner);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Installed component directories must not be symbolic links');
  // Profile edits acquire the profile lock before the component lock; installation never acquires a profile lock.
  return withFileLock(path, () => withFileLock(join(owner, 'installation'), async () => {
    const before = await optionalPatch(path, DEFAULT_LIMITS.patchBytes);
    if (revision(before) !== options.expectedPatchRevision) throw new Error('The profile changed after confirmation; read it again before activating');
    const target = await installed(root, options.id, options.version);
    if (firstUpdater && (target.descriptor.id !== 'updates' || target.descriptor.packageName !== '@clawmaster/dsh-updates'
      || target.descriptor.activation !== 'restart')) throw new Error('Updater bootstrap requires the official restart-only updater component');
    const bootstrapState = firstUpdater ? await initialUpdaterState(options.dshHome, root, before) : undefined;
    await rejectInstalledDowngrade(options.dshHome, options.id, options.version);
    const after = await nextPatch(before, root, target);
    if (parseDocument(after).errors.length) throw new Error('Component activation could not preserve the YAML document');
    if (Buffer.byteLength(after) > DEFAULT_LIMITS.patchBytes) throw new Error('Component profile patch exceeds its size limit');
    const token = randomUUID();
    const staged = target.descriptor.activation === 'restart' && !firstUpdater;
    const patchRevision = revision(staged ? before : after);
    await writeFile(join(root, 'operations', `${token}.json`), json({ before, after, afterRevision: patchRevision, id: options.id,
      version: options.version, activation: target.descriptor.activation, state: staged ? 'staged' : 'applied' }), { flag: 'wx', mode: 0o600 });
    if (revision(await optionalPatch(path, DEFAULT_LIMITS.patchBytes)) !== options.expectedPatchRevision) throw new Error('The profile changed during activation; no update was applied');
    if (firstUpdater && await initialUpdaterState(options.dshHome, root, before) !== bootstrapState) throw new Error('User configuration changed during updater bootstrap; no update was applied');
    if (!staged) await writeFileAtomic(path, after, { mode: 0o600, dirMode: 0o700 });
    return { status: staged ? 'restart-required' : 'activation-pending',
      rowId: `clawmaster-update-component-${options.id}`, entryUrl: target.entryUrl, patchRevision, rollbackToken: token };
  }));
}

/**
 * Restore the exact previous profile only while its confirmed successor revision remains current.
 * A restored component must still match its receipt and file hashes under the installation lock; explicit rollback may select an older verified version.
 * @param options - opaque activation receipt token and current user-confirmed patch revision.
 * @returns pending reload/restart state; a concurrent user edit rejects rollback without replacing the file.
 */
export async function rollbackComponent(options: { dshHome: string; rollbackToken: string; expectedPatchRevision: string; confirmed: boolean }): Promise<{ status: 'activation-pending' | 'restart-required'; patchRevision: string }> {
  if (!options.confirmed) throw new Error('Component rollback requires explicit confirmation');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(options.rollbackToken)) throw new Error('Invalid component rollback token');
  const root = await stateRoot(options.dshHome);
  const path = await patchPath(options.dshHome);
  return withFileLock(path, async () => {
    const recordPath = join(root, 'operations', `${options.rollbackToken}.json`);
    const record = await readOperation(root, options.rollbackToken);
    if (typeof record.before !== 'string' || Buffer.byteLength(record.before) > DEFAULT_LIMITS.patchBytes
      || typeof record.id !== 'string' || !ID.test(record.id) || valid(record.version) !== record.version
      || !['hot', 'restart'].includes(record.activation) || !['staged', 'applied', 'completed'].includes(record.state) || record.afterRevision !== options.expectedPatchRevision
      || revision(await optionalPatch(path, DEFAULT_LIMITS.patchBytes)) !== options.expectedPatchRevision) {
      throw new Error('The profile changed after activation; rollback would overwrite newer edits');
    }
    const owner = join(root, 'components', record.id);
    const info = await lstat(owner);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Installed component directories must not be symbolic links');
    return withFileLock(join(owner, 'installation'), async () => {
      if (record.state !== 'staged') await verifyRollbackEntry(root, record.id, record.before);
      const current = await optionalPatch(path, DEFAULT_LIMITS.patchBytes);
      if (revision(current) !== options.expectedPatchRevision) throw new Error('The profile changed during rollback; no update was applied');
      if (record.state !== 'staged' && record.activation === 'restart') {
        const doc = parseDocument(record.before);
        let entry: string | undefined;
        visit(doc, { Map(_key, node) {
          const name = node.get('name');
          if (node.get('id') === `clawmaster-update-component-${record.id}` && typeof name === 'string') entry = name;
        } });
        if (entry === undefined) throw new Error('This rollback removes the updater; use the offline repair installer instead');
        const previousVersion = relative(join(root, 'components', record.id), fileURLToPath(entry)).split(/[\\/]/)[0]!;
        await installed(root, record.id, previousVersion);
        await writeFileAtomic(recordPath, json({ before: current, after: record.before, afterRevision: options.expectedPatchRevision,
          id: record.id, version: previousVersion, activation: record.activation, direction: 'rollback', state: 'staged' }), { mode: 0o600, dirMode: 0o700 });
        return { status: 'restart-required', patchRevision: options.expectedPatchRevision };
      }
      if (record.state !== 'staged') await writeFileAtomic(path, record.before, { mode: 0o600, dirMode: 0o700 });
      await rm(recordPath);
      return { status: record.activation === 'restart' ? 'restart-required' : 'activation-pending', patchRevision: revision(record.before) };
    });
  });
}
