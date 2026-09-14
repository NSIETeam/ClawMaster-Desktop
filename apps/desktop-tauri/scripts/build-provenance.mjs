/** Bind desktop build stages to Git source bytes without distributing Git metadata. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, globSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Complete compiler output and source record retained only in the checkout. */
export const HARNESS_PROVENANCE_PATH = '.dsh-build/desktop-harness-provenance.json'
/** Product preparation record checked before assembling the installer payload. */
export const PREPARED_PROVENANCE_PATH = '.dsh-build/desktop-prepared-provenance.json'
/** Public provenance copied into the payload and covered by its content digest. */
export const PAYLOAD_PROVENANCE_PATH = '.build-provenance.json'

// Tauri regenerates these from the committed SVG before any native packaging.
const generatedIcons = [
  '32x32.png', '64x64.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.ico', 'icon.icns',
].map(name => `apps/desktop-tauri/src-tauri/icons/${name}`)
generatedIcons.push('apps/desktop-tauri/app-icon.png')
const sourceExclusions = new Set(generatedIcons)
const artifactPatterns = {
  harness: ['apps/cli/lib/**/*', 'apps/web/dist/**/*', 'packages/*/*/lib/**/*', 'vendor/*/lib/**/*', 'native/system/packages/*/lib/**/*'],
  product: ['frontends/dsh/dist/**/*', 'frontends/guard/dist/**/*', 'frontends/notes/dist/**/*', 'frontends/office/dist/**/*', 'frontends/rpa/dist/**/*', 'frontends/office/runtime/.clawmaster-office-manifest.json', 'native/system/packages/*/bin/**/*', 'apps/desktop-tauri/dist/**/*', ...generatedIcons],
}

/** @param {NodeJS.ProcessEnv} environment @returns {'release' | 'development'} Explicit release mode or labelled development output. */
export function desktopBuildMode(environment = process.env) {
  const mode = environment.DSH_DESKTOP_BUILD_MODE ?? 'development'
  if (mode !== 'release' && mode !== 'development') throw new Error('DSH_DESKTOP_BUILD_MODE must be release or development')
  return mode
}

/** @param {string} root @param {string[]} args @returns {string} Git output, with no inherited output or credential logging. */
function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
}

/** @param {string} root @param {string[]} paths @returns {{fileCount:number, sha256:string}} Framed path, entry kind and content digest. */
function digestFiles(root, paths) {
  const hash = createHash('sha256')
  for (const path of paths) {
    const absolute = join(root, path)
    const info = lstatSync(absolute, { throwIfNoEntry: false })
    if (info !== undefined && !info.isFile() && !info.isSymbolicLink()) throw new Error(`Build source is not a file: ${path}`)
    const kind = info === undefined ? 'missing' : info.isSymbolicLink() ? 'symlink' : 'file'
    const bytes = info === undefined ? Buffer.alloc(0) : info.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute)
    hash.update(`${Buffer.byteLength(path)}:${path}:${kind}:${bytes.length}:`)
    hash.update(bytes)
  }
  return { fileCount: paths.length, sha256: hash.digest('hex') }
}

/**
 * Snapshot tracked and nonignored untracked source; generated native icons are separate artifacts.
 * @param {string} root - Git checkout used by the build.
 * @param {'release'|'development'} mode - Release rejects staged, unstaged and untracked source edits.
 * @returns {{gitCommit:string, gitTree:string, sourceSha256:string, sourceFileCount:number, dirty:boolean, dirtyFiles:string[]}}
 */
export function captureBuildSource(root, mode = desktopBuildMode()) {
  const gitCommit = git(root, ['rev-parse', 'HEAD']).trim()
  const gitTree = git(root, ['rev-parse', 'HEAD^{tree}']).trim()
  const split = value => value.split('\0').filter(Boolean).filter(path => !sourceExclusions.has(path))
  const dirtyFiles = [...new Set([
    ...split(git(root, ['diff', '--name-only', '--no-renames', '-z', '--'])),
    ...split(git(root, ['diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD', '--'])),
    ...split(git(root, ['ls-files', '--others', '--exclude-standard', '-z'])),
  ])].sort()
  if (mode === 'release' && dirtyFiles.length > 0) throw new Error(`Release requires clean source; changed files: ${dirtyFiles.join(', ')}`)
  const paths = [...new Set(split(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])))].sort()
  const digest = digestFiles(root, paths)
  return { gitCommit, gitTree, sourceSha256: digest.sha256, sourceFileCount: digest.fileCount, dirty: dirtyFiles.length > 0, dirtyFiles }
}

/** @param {string} root @param {ReturnType<typeof captureBuildSource>} source @param {'release'|'development'} mode @returns {void} Reject source changes during or after compilation. */
function assertSource(root, source, mode) {
  if (JSON.stringify(captureBuildSource(root, mode)) !== JSON.stringify(source)) throw new Error('Desktop source differs from the recorded build; rebuild the harness from this source')
}

/** @param {string} root @param {'harness'|'product'} stage @returns {{fileCount:number,sha256:string}} Current files in a declared build stage. */
function artifactDigest(root, stage) {
  const paths = [...new Set(globSync(artifactPatterns[stage], { cwd: root }))]
    .map(path => path.replaceAll('\\', '/')).filter(path => lstatSync(join(root, path)).isFile()).sort()
  if (paths.length === 0) throw new Error(`Desktop ${stage} artifacts are missing`)
  return digestFiles(root, paths)
}

/** @param {string} root @param {string} path @param {unknown} value @returns {void} Write a build-owned record, excluded from source discovery. */
function writeRecord(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`)
}

/** @param {string} root @param {string} path @param {'release'|'development'} mode @returns {object} Validated build-stage provenance. */
function readRecord(root, path, mode) {
  if (!existsSync(join(root, path))) throw new Error(`Desktop build provenance missing: ${path}; run build:harness and prepare:dist`)
  const value = JSON.parse(readFileSync(join(root, path), 'utf8'))
  if (value?.schemaVersion !== 1 || value.mode !== mode || typeof value.source?.gitCommit !== 'string'
    || !/^[a-f0-9]{40,64}$/.test(value.source.gitCommit) || !/^[a-f0-9]{64}$/.test(value.source.sourceSha256)
    || typeof value.source.dirty !== 'boolean' || !Array.isArray(value.source.dirtyFiles)) {
    throw new Error(`Desktop build provenance is invalid or belongs to another build mode: ${path}`)
  }
  return value
}

/**
 * Record only after the complete harness compiler and branding operation succeeded.
 * @param {string} root @param {ReturnType<typeof captureBuildSource>} source @param {'release'|'development'} mode
 * @returns {object} Source and artifact binding consumed by desktop preparation.
 */
export function recordHarnessBuild(root, source, mode = desktopBuildMode()) {
  assertSource(root, source, mode)
  const value = { schemaVersion: 1, mode, source, artifacts: { harness: artifactDigest(root, 'harness') },
    toolchain: { node: process.version, platform: process.platform, arch: process.arch } }
  writeRecord(root, HARNESS_PROVENANCE_PATH, value)
  return value
}

/** @param {string} root @param {'release'|'development'} mode @returns {object} Reject a reused build from different source or altered Host/client artifacts. */
export function verifyHarnessBuild(root, mode = desktopBuildMode()) {
  const value = readRecord(root, HARNESS_PROVENANCE_PATH, mode)
  assertSource(root, value.source, mode)
  if (JSON.stringify(value.artifacts?.harness) !== JSON.stringify(artifactDigest(root, 'harness'))) throw new Error('Desktop harness artifacts differ from their recorded source build')
  return value
}

/**
 * Bind freshly built product frontends, verified Office resources, splash and generated icons.
 * @param {string} root @param {ReturnType<typeof captureBuildSource>} source @param {'release'|'development'} mode
 * @returns {object} Complete provenance for the payload manifest and release attachment.
 */
export function recordPreparedBuild(root, source, mode = desktopBuildMode()) {
  const harness = verifyHarnessBuild(root, mode)
  assertSource(root, source, mode)
  const value = { ...harness,
    buildId: `${mode}${source.dirty ? '-dirty' : ''}-${source.gitCommit.slice(0, 12)}-${source.sourceSha256.slice(0, 12)}`,
    artifacts: { ...harness.artifacts, product: artifactDigest(root, 'product') } }
  writeRecord(root, PREPARED_PROVENANCE_PATH, value)
  return value
}

/** @param {string} root @param {'release'|'development'} mode @returns {object} Verify both stages before the prepared payload can replace an older one. */
export function verifyPreparedBuild(root, mode = desktopBuildMode()) {
  const value = readRecord(root, PREPARED_PROVENANCE_PATH, mode)
  const harness = verifyHarnessBuild(root, mode)
  if (JSON.stringify(value.source) !== JSON.stringify(harness.source)
    || JSON.stringify(value.artifacts) !== JSON.stringify({ ...harness.artifacts, product: artifactDigest(root, 'product') })) {
    throw new Error('Desktop product artifacts differ from their recorded source build')
  }
  return value
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const source = captureBuildSource(root)
  console.log(JSON.stringify({ mode: desktopBuildMode(), source }, null, 2))
}
