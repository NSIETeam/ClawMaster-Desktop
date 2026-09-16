import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { create } from 'tar';
import { parseDocument } from 'yaml';

const artifact = process.env.CLAWMASTER_COMPONENT_ARTIFACT;
const componentUrl = artifact ? pathToFileURL(resolve(artifact)).href : new URL('../src/components.ts', import.meta.url).href;
const bootstrapUrl = artifact ? componentUrl : new URL('../src/bootstrap.ts', import.meta.url).href;
const { installComponent, readComponentPatchRevision, rollbackComponent } = await import(componentUrl);
const { bootstrapUpdater } = await import(bootstrapUrl);
const descriptor = { id: 'updates', packageName: '@clawmaster/dsh-updates', version: '0.1.0', entry: './dist/index.js',
  kind: 'component', activation: 'restart', requiresDshVersion: '>=0.1.5-rc.2' };

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-bootstrap-'));
  try {
    const dshHome = join(root, 'home');
    await mkdir(dshHome);
    const profile = join(dshHome, 'profiles', 'web');
    const patch = join(profile, 'cordis.patch.yml');
    const source = join(root, 'source');
    await mkdir(join(source, 'package', 'dist'), { recursive: true });
    await writeFile(join(source, 'package', 'dist', 'index.js'), 'export const name = "clawmaster-updates"; export function apply(ctx) { ctx.provide("bootstrap-fixture", true); }\n');
    const install = async (change = {}) => {
      const selected = { ...descriptor, ...change };
      await writeFile(join(source, 'package', 'package.json'), JSON.stringify({ name: selected.packageName, version: selected.version, type: 'module' }));
      const archivePath = join(root, 'updater.tgz');
      await create({ cwd: source, gzip: true, file: archivePath }, ['package']);
      return installComponent({ archivePath, descriptor: selected, dshHome, dshVersion: '0.1.5-rc.2' });
    };
    const initializePatch = async text => { await mkdir(profile, { recursive: true }); await writeFile(patch, text); };
    const bootstrap = async (options = {}) => bootstrapUpdater({ dshHome, version: descriptor.version,
      expectedPatchRevision: await readComponentPatchRevision(dshHome), confirmed: true, ...options });
    await run({ root, dshHome, profile, patch, install, initializePatch, bootstrap });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('first updater bootstrap preserves user rows and returns pending observation of an importable entry', async () => fixture(async ({ patch, install, initializePatch, bootstrap }) => {
  const original = '# user preference\n- id: existing\n  config:\n    value: !!js process.env.EXAMPLE # preserve source\n';
  await initializePatch(original);
  const installed = await install();
  const result = await bootstrap();
  assert.equal(result.status, 'activation-pending');
  const text = await readFile(patch, 'utf8');
  assert.ok(text.startsWith(original));
  const doc = parseDocument(text);
  assert.deepEqual(doc.errors, []);
  assert.deepEqual(doc.toJSON().at(-1), { insert: [{ id: 'clawmaster-update-component-updates', name: installed.entryUrl }] });
  const module = await import(installed.entryUrl);
  const observed = new Map();
  module.apply({ provide(key, value) { observed.set(key, value); } });
  assert.equal(observed.get('bootstrap-fixture'), true);
}));

test('a denied bootstrap reads no installation state and creates nothing', async () => fixture(async ({ dshHome, bootstrap }) => {
  const before = await readdir(dshHome);
  await assert.rejects(bootstrap({ confirmed: false }), /explicit confirmation/);
  assert.deepEqual(await readdir(dshHome), before);
}));

test('an existing updater can never be replaced by bootstrap, including caller claims that the Host stopped', async () => fixture(async ({ dshHome, patch, install, bootstrap }) => {
  await install();
  await bootstrap();
  const before = await readFile(patch, 'utf8');
  const records = await readdir(join(dshHome, 'clawmaster-updates', 'operations'));
  await install({ version: '0.2.0' });
  await assert.rejects(bootstrap({ version: '0.2.0', hostStopped: true }), /first-install only/);
  await assert.rejects(bootstrap(), /first-install only/);
  assert.equal(await readFile(patch, 'utf8'), before);
  assert.deepEqual(await readdir(join(dshHome, 'clawmaster-updates', 'operations')), records);
}));

test('disabled, colliding and duplicate updater rows remain untouched', async () => fixture(async ({ patch, install, initializePatch, bootstrap }) => {
  await install();
  for (const text of [
    '- insert:\n    - id: clawmaster-update-component-updates\n      name: custom-plugin\n      disabled: true\n',
    '- insert:\n    - id: user-selected-name\n      name: "@clawmaster/dsh-updates"\n',
    '- id: clawmaster-update-component-updates\n- id: clawmaster-update-component-updates\n',
  ]) {
    await initializePatch(text);
    await assert.rejects(bootstrap(), /first-install only/);
    assert.equal(await readFile(patch, 'utf8'), text);
  }
}));

test('home patches and profile-declared updater bundles also block duplicate bootstrap', async () => fixture(async ({ dshHome, profile, patch, install, initializePatch, bootstrap }) => {
  await install();
  await initializePatch('# web is empty\n[]\n');
  const homePatch = join(dshHome, 'cordis.patch.yml');
  const homeText = '- insert:\n    - id: global-updater\n      name: "@clawmaster/dsh-updates"\n';
  await writeFile(homePatch, homeText);
  await assert.rejects(bootstrap(), /first-install only/);
  assert.equal(await readFile(homePatch, 'utf8'), homeText);
  await rm(homePatch);
  for (const manifest of [
    { dependencies: { '@clawmaster/dsh-updates': '0.1.0' } },
    { dsh: { profile: { bundles: ['@clawmaster/dsh-updates'] } } },
  ]) {
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(bootstrap(), /already declares/);
  }
  assert.equal(await readFile(patch, 'utf8'), '# web is empty\n[]\n');
}));

test('bootstrap requires the official installed package identity and refuses modified installed bytes', async () => fixture(async ({ dshHome, install, bootstrap }) => {
  const wrong = await install({ packageName: '@clawmaster/something-else' });
  await assert.rejects(bootstrap(), /official restart-only/);
  await rm(wrong.directory, { recursive: true });
  const official = await install();
  await writeFile(join(official.directory, 'package', 'dist', 'index.js'), 'tampered');
  await assert.rejects(bootstrap(), /digest differs/);
  await assert.rejects(readFile(join(dshHome, 'profiles', 'web', 'cordis.patch.yml')), { code: 'ENOENT' });
}));

test('stale revisions and concurrent first-install calls cannot overwrite a newer profile', async () => fixture(async ({ dshHome, patch, install, initializePatch, bootstrap }) => {
  await install();
  await initializePatch('[]\n');
  const stale = await readComponentPatchRevision(dshHome);
  await writeFile(patch, '# newer user change\n[]\n');
  await assert.rejects(bootstrap({ expectedPatchRevision: stale }), /profile changed/);
  assert.equal(await readFile(patch, 'utf8'), '# newer user change\n[]\n');
  const expectedPatchRevision = await readComponentPatchRevision(dshHome);
  const results = await Promise.allSettled([bootstrap({ expectedPatchRevision }), bootstrap({ expectedPatchRevision })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /profile changed/);
  const rows = parseDocument(await readFile(patch, 'utf8')).toJSON();
  assert.equal(rows.filter(row => row.insert?.[0]?.id === 'clawmaster-update-component-updates').length, 1);
}));

test('a first updater installation has no previous version and cannot remove its live entry through rollback', async () => fixture(async ({ dshHome, patch, install, bootstrap }) => {
  await install();
  const result = await bootstrap();
  const mounted = await readFile(patch, 'utf8');
  await assert.rejects(rollbackComponent({ dshHome, rollbackToken: result.rollbackToken, expectedPatchRevision: result.patchRevision, confirmed: true }), /removes the updater/);
  assert.equal(await readFile(patch, 'utf8'), mounted);
  const operation = JSON.parse(await readFile(join(dshHome, 'clawmaster-updates', 'operations', `${result.rollbackToken}.json`), 'utf8'));
  assert.equal(operation.state, 'applied');
  assert.equal(operation.after, mounted);
}));
