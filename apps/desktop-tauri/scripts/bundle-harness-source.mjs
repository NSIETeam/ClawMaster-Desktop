/**
 * Bundle a trimmed harness monorepo slice for the Tauri installer.
 *
 * Ships source + pre-built lib/dist artifacts, never node_modules.
 * First-run provisioning runs `pnpm install --prod` against this tree.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, globSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { load as loadYaml } from 'js-yaml'
import { DESKTOP_PLUGIN_VERSIONS } from './desktop-defaults.mjs'
import { desktopBuildMode, PAYLOAD_PROVENANCE_PATH, verifyPreparedBuild } from './build-provenance.mjs'

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(desktopRoot, '..', '..')
const outRoot = join(desktopRoot, 'bundled', 'harness')

const skipDirNames = new Set([
  'node_modules', '.git', '.turbo', 'coverage', 'release', '.stage', '.cache',
  'tests', 'test', '__tests__', 'dist-test',
])

const trimmedPackages = [
  'vendor/*',
  'packages/*/*',
  'native/system',
  'native/system/packages/*',
  'apps/cli',
  'apps/web',
  'apps/desktop-defaults',
  'frontends/dsh',
  'frontends/guard',
  'frontends/notes',
  'frontends/office',
  'frontends/rpa',
]

/** Reviewed compatibility patches applied by pnpm before any desktop launch. */
export const DESKTOP_PATCHED_DEPENDENCIES = Object.freeze({
  '@nanmicoder/dsh-agent-teams@0.1.17': 'desktop-patches/@nanmicoder__dsh-agent-teams@0.1.17.patch',
  '@xmanrui/dsh-im@4.20.0': 'desktop-patches/@xmanrui__dsh-im@4.20.0.patch',
  'dsh-better-sidebar@0.19.1': 'desktop-patches/dsh-better-sidebar@0.19.1.patch',
  '@openviking/dsh-memory-plugin@0.3.0': 'desktop-patches/@openviking__dsh-memory-plugin@0.3.0.patch',
  'dsh-routing-suite@0.1.2': 'desktop-patches/dsh-routing-suite@0.1.2.patch',
})

/**
 * Reject locks that do not contain the reviewed plugin releases and current compatibility patches.
 * @param {string} content - Validated production pnpm lockfile.
 * @param {string} patchRoot - Desktop-owned patch directory.
 * @returns {void} Throws before the existing prepared payload is replaced.
 */
export function assertDesktopLockfile(content, patchRoot) {
  const lock = loadYaml(content)
  const dependencies = lock?.importers?.['apps/cli']?.dependencies
  for (const [name, version] of Object.entries(DESKTOP_PLUGIN_VERSIONS)) {
    if (dependencies?.[name]?.specifier !== version) throw new Error(`Desktop lock must pin ${name}@${version}`)
  }
  for (const [name, path] of Object.entries(DESKTOP_PATCHED_DEPENDENCIES)) {
    const expected = createHash('sha256').update(readFileSync(join(patchRoot, path.slice('desktop-patches/'.length)))).digest('hex')
    if (lock?.patchedDependencies?.[name] !== expected) throw new Error(`Desktop lock has a stale compatibility patch: ${name}`)
  }
  if (Object.keys(lock?.packages ?? {}).some(name => name.startsWith('@deepseek-ai/dsh-') || name.startsWith('@deepseek-ai/dsh@'))) {
    throw new Error('Desktop lock must resolve DSH peers from the packaged workspaces, not registry copies')
  }
}

const desktopPackageExtensions = {
  '@openviking/dsh-memory-plugin@0.3.0': {
    dependencies: { zod: '4.4.3' },
    peerDependencies: { '@deepseek-ai/dsh-session-projection': '0.1.5-rc.2' },
  },
  'dsh-routing-suite@0.1.2': { dependencies: { zod: '4.4.3' } },
}

const skipPackageGroups = new Set(['examples', 'test-support', 'experimental'])

const skipFileSuffixes = ['.spec.ts', '.e2e.ts', '.snapshot.ts']

/**
 * 从仓库配置裁剪工作区成员，允许生产包未使用的开发依赖补丁。
 * 保留补丁、构建许可和 overrides；实际补丁应用失败仍阻止安装。
 *
 * @param {string} sourceYaml
 * @param {Record<string, string>} workspaceOverrides - Installation-owned DSH packages keyed by name.
 * @returns {string}
 */
export function buildTrimmedWorkspaceYaml(sourceYaml, workspaceOverrides = {}) {
  const lines = sourceYaml.split(/\r?\n/)
  const packagesIndex = lines.findIndex(line => /^packages:\s*$/.test(line))
  if (packagesIndex === -1) {
    throw new Error('pnpm-workspace.yaml has no packages: block to trim')
  }
  let end = packagesIndex + 1
  while (end < lines.length && (lines[end].trim() === '' || /^[ \t]/.test(lines[end]))) {
    end += 1
  }
  const trimmedBlock = [
    'packages:',
    ...trimmedPackages.map(name => `  - ${name}`),
    '',
  ]
  // 裁剪树不含开发工具，允许其补丁未使用；已安装依赖的补丁应用失败仍由 pnpm 报错。
  const output = [...lines.slice(0, packagesIndex), ...trimmedBlock, ...lines.slice(end)]
    .filter(line => !/^allowUnusedPatches:/.test(line))
  const reviewedReleases = Object.entries(DESKTOP_PLUGIN_VERSIONS)
    .map(([name, version]) => `  - '${name}@${version}'`)
  const releaseAgeIndex = output.findIndex(line => /^minimumReleaseAgeExclude:\s*$/.test(line))
  if (releaseAgeIndex === -1) output.push('', 'minimumReleaseAgeExclude:', ...reviewedReleases)
  else output.splice(releaseAgeIndex + 1, 0, ...reviewedReleases)
  const extend = (key, entries) => {
    if (Object.keys(entries).length === 0) return
    const additions = Object.entries(entries).map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`)
    const index = output.findIndex(line => line === `${key}:`)
    if (index === -1) output.push('', `${key}:`, ...additions)
    else output.splice(index + 1, 0, ...additions)
  }
  extend('overrides', workspaceOverrides)
  extend('patchedDependencies', DESKTOP_PATCHED_DEPENDENCIES)
  extend('packageExtensions', desktopPackageExtensions)
  return output.join('\n').trimEnd() + '\n\nallowUnusedPatches: true\n'
}

/**
 * Keep every DSH dependency on this installation's workspace, including external plugin peers.
 * @param {string} root - Trimmed installation tree.
 * @returns {Record<string, string>} Exact package-name overrides to local workspace paths.
 */
export function desktopWorkspaceOverrides(root) {
  const overrides = {}
  const groups = join(root, 'packages')
  for (const group of readdirSync(groups, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const entry of readdirSync(join(groups, group.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join('packages', group.name, entry.name)
      const manifestPath = join(root, path, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.name?.startsWith('@deepseek-ai/dsh-')) overrides[manifest.name] = `link:${path.replaceAll('\\', '/')}`
    }
  }
  return overrides
}

/** @param {string} sourceRoot @param {string} source */
function shouldCopyEntry(sourceRoot, source) {
  const rel = relative(sourceRoot, source)
  if (rel === '') return !skipDirNames.has(basename(source))
  const parts = rel.split(sep)
  if (parts.some(part => skipDirNames.has(part))) return false
  const base = parts[parts.length - 1]
  if (skipFileSuffixes.some(suffix => base.endsWith(suffix))) return false
  if (base.startsWith('README') && parts.length > 2) return false
  return true
}

/** @param {string} current @param {import('node:crypto').Hash} hasher @param {string} relPrefix */
function hashBundleWalk(current, hasher, relPrefix) {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const path = join(current, entry.name)
    if (entry.name === '.bundle-manifest.json') continue
    if (entry.isDirectory()) {
      const dirRel = relPrefix ? `${relPrefix}/${entry.name}`.replaceAll('\\', '/') : entry.name.replaceAll('\\', '/')
      hashBundleWalk(path, hasher, dirRel)
      continue
    }
    if (!entry.isFile()) continue
    const rel = relPrefix ? `${relPrefix}/${entry.name}`.replaceAll('\\', '/') : entry.name.replaceAll('\\', '/')
    hasher.update(rel)
    hasher.update(readFileSync(path))
  }
}

/**
 * Hash the complete prepared payload, including desktop defaults and built frontend.
 * @param {string} root - Trimmed tree without node_modules.
 * @returns {string} SHA-256 used to isolate the writable installation generation.
 */
export function hashBundledContent(root) {
  const hasher = createHash('sha256')
  hashBundleWalk(root, hasher, '')
  return hasher.digest('hex')
}

/**
 * Reject modified payloads or development dependencies before installer packaging.
 * @param {string} root - Prepared, uninstalled harness tree.
 * @param {'release'|'development'} mode - Packaging policy inherited from the selected build mode.
 * @returns {void} Throws for unexpected entries or a stale manifest digest.
 */
export function assertPreparedBundle(root, mode = desktopBuildMode()) {
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Prepared payload contains a symbolic link: ${path}`)
      if (entry.isDirectory()) {
        if (skipDirNames.has(entry.name)) throw new Error(`Prepared payload contains an excluded directory: ${path}`)
        walk(path)
      }
    }
  }
  walk(root)
  const manifest = JSON.parse(readFileSync(join(root, '.bundle-manifest.json'), 'utf8'))
  if (manifest.contentSha256 !== hashBundledContent(root)) throw new Error('Prepared payload digest does not match its manifest')
  const provenance = JSON.parse(readFileSync(join(root, PAYLOAD_PROVENANCE_PATH), 'utf8'))
  if (JSON.stringify(provenance) !== JSON.stringify(manifest.buildProvenance)) throw new Error('Prepared payload provenance differs from its manifest')
  if (provenance.schemaVersion !== 1 || !['development', 'release'].includes(provenance.mode)
    || typeof provenance.buildId !== 'string' || typeof provenance.source?.dirty !== 'boolean') {
    throw new Error('Prepared payload provenance is invalid')
  }
  if (mode === 'release' && (provenance.mode !== 'release' || provenance.source.dirty)) {
    throw new Error('Release payload must come from a clean release build')
  }
}

/**
 * Add installation-owned defaults to the CLI dependency closure used by profile resolution.
 * @param {object} manifest - CLI package metadata.
 * @param {Record<string, string>} workspaceOverrides - DSH packages provided by the same installation.
 * @returns {object} Metadata for the trimmed installation only.
 */
export function withDesktopDependencies(manifest, workspaceOverrides = {}) {
  return {
    ...manifest,
    dependencies: {
      ...manifest.dependencies,
      ...Object.fromEntries(Object.keys(workspaceOverrides).map(name => [name, 'workspace:*'])),
      ...DESKTOP_PLUGIN_VERSIONS,
      '@clawmaster/dsh-desktop-policy': 'workspace:*',
      '@clawmaster/dsh-frontend': 'workspace:*',
      '@clawmaster/dsh-guard': 'workspace:*',
      '@clawmaster/dsh-notes': 'workspace:*',
      '@clawmaster/dsh-office': 'workspace:*',
      '@clawmaster/dsh-rpa': 'workspace:*',
    },
  }
}

/**
 * Copy distributable files, including when the selected root is an excluded directory.
 * @param {string} src
 * @param {string} dest
 * @returns {void}
 */
export function copyTree(src, dest) {
  if (!existsSync(src)) return
  if (skipDirNames.has(basename(src))) return
  if (statSync(src).isFile()) {
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    return
  }
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, {
    recursive: true,
    dereference: true,
    filter: candidate => shouldCopyEntry(src, candidate),
  })
}

function assertBuiltArtifacts() {
  execFileSync(process.execPath, ['--import', 'tsx/esm', join(desktopRoot, 'scripts', 'build-harness.ts'), '--check'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  execFileSync(process.execPath, [join(repoRoot, 'frontends/office/scripts/build.mjs'), '--check'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  execFileSync(process.execPath, [join(repoRoot, 'frontends/notes/scripts/build.mjs'), '--check'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  execFileSync(process.execPath, [join(repoRoot, 'frontends/guard/scripts/build.mjs'), '--check'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  execFileSync(process.execPath, [join(repoRoot, 'frontends/rpa/scripts/build.mjs'), '--check'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  const cliBin = join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
  const webIndex = join(repoRoot, 'apps', 'web', 'dist', 'index.html')
  const systemEntry = join(repoRoot, 'native', 'system', 'packages', 'entry', 'lib', 'index.js')
  if (!existsSync(cliBin) || !existsSync(webIndex)) {
    throw new Error(
      'Harness build artifacts missing. From repo root run: pnpm run build',
    )
  }
  if (!existsSync(systemEntry)) {
    throw new Error(
      'system entry lib missing. From native/system run: pnpm run build:ts',
    )
  }
  for (const name of ['index.js', 'client.js']) {
    if (!existsSync(join(repoRoot, 'frontends/dsh/dist', name))) {
      throw new Error('ClawMaster frontend build missing. Run: npm --prefix frontends/dsh run build')
    }
    if (!existsSync(join(repoRoot, 'frontends/notes/dist', name))) {
      throw new Error('ClawMaster notes build missing. Run: node frontends/notes/scripts/build.mjs')
    }
  }
  if (!existsSync(join(repoRoot, 'frontends/guard/dist/index.js'))) {
    throw new Error('ClawMaster guard build missing. Run: node frontends/guard/scripts/build.mjs')
  }
  if (!existsSync(join(repoRoot, 'frontends/rpa/dist/index.js'))) {
    throw new Error('ClawMaster RPA build missing. Run: node frontends/rpa/scripts/build.mjs')
  }
}

/**
 * Remove development dependencies from workspace manifests while preserving embedded source records.
 * @param {string} root - Prepared harness workspace.
 * @returns {void}
 */
export function stripDevDependencies(root) {
  for (const pattern of trimmedPackages) {
    for (const file of globSync(`${pattern}/package.json`, { cwd: root })) {
      const path = join(root, file)
      const pkg = JSON.parse(readFileSync(path, 'utf8'))
      if (!pkg.devDependencies) continue
      delete pkg.devDependencies
      writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
    }
  }
}

function main() {
assertBuiltArtifacts()
const buildProvenance = verifyPreparedBuild(repoRoot)
const desktopLock = readFileSync(join(desktopRoot, 'pnpm-desktop-lock.yaml'), 'utf8')
assertDesktopLockfile(desktopLock, join(desktopRoot, 'patches'))
rmSync(outRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
mkdirSync(outRoot, { recursive: true })

for (const name of ['package.json', 'pnpm-workspace.yaml', 'LICENSE', 'NOTICE']) {
  copyTree(join(repoRoot, name), join(outRoot, name))
}
writeFileSync(join(outRoot, 'pnpm-lock.yaml'), desktopLock)

if (existsSync(join(repoRoot, 'patches'))) {
  copyTree(join(repoRoot, 'patches'), join(outRoot, 'patches'))
}
copyTree(join(desktopRoot, 'patches'), join(outRoot, 'desktop-patches'))
for (const patch of Object.values(DESKTOP_PATCHED_DEPENDENCIES)) {
  if (!existsSync(join(outRoot, patch))) throw new Error(`Desktop compatibility patch missing: ${patch}`)
}

copyTree(join(repoRoot, 'vendor'), join(outRoot, 'vendor'))
copyTree(join(repoRoot, 'native', 'system'), join(outRoot, 'native', 'system'))
copyTree(join(repoRoot, 'apps', 'cli'), join(outRoot, 'apps', 'cli'))
copyTree(join(repoRoot, 'apps', 'web'), join(outRoot, 'apps', 'web'))
copyTree(join(desktopRoot, 'defaults'), join(outRoot, 'apps', 'desktop-defaults'))
for (const frontend of ['dsh', 'guard', 'notes', 'office', 'rpa']) {
  for (const name of ['package.json', 'dist', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    copyTree(join(repoRoot, 'frontends', frontend, name), join(outRoot, 'frontends', frontend, name))
  }
}
for (const name of ['runtime', 'patches', 'scripts', 'src', 'vendor', 'package-lock.json']) {
  copyTree(join(repoRoot, 'frontends', 'office', name), join(outRoot, 'frontends', 'office', name))
}
copyTree(join(desktopRoot, 'scripts', 'desktop-defaults.mjs'), join(outRoot, 'desktop-defaults.mjs'))
const cliManifestPath = join(outRoot, 'apps', 'cli', 'package.json')

const packagesRoot = join(repoRoot, 'packages')
for (const group of readdirSync(packagesRoot, { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  if (skipPackageGroups.has(group.name)) continue
  const groupPath = join(packagesRoot, group.name)
  for (const pkg of readdirSync(groupPath, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    copyTree(join(groupPath, pkg.name), join(outRoot, 'packages', group.name, pkg.name))
  }
}

const workspaceOverrides = desktopWorkspaceOverrides(outRoot)
writeFileSync(cliManifestPath, `${JSON.stringify(withDesktopDependencies(JSON.parse(readFileSync(cliManifestPath, 'utf8')), workspaceOverrides), null, 2)}\n`)
const trimmedWorkspace = buildTrimmedWorkspaceYaml(
  readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'),
  workspaceOverrides,
)
writeFileSync(join(outRoot, 'pnpm-workspace.yaml'), trimmedWorkspace)

const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const bundlePkg = {
  name: '@deepseek-ai/dsh-desktop-bundle',
  private: true,
  version: rootPkg.version,
  packageManager: rootPkg.packageManager ?? 'pnpm@11.7.0',
}
writeFileSync(join(outRoot, 'package.json'), `${JSON.stringify(bundlePkg, null, 2)}\n`)

stripDevDependencies(outRoot)
writeFileSync(join(outRoot, PAYLOAD_PROVENANCE_PATH), `${JSON.stringify(buildProvenance, null, 2)}\n`)

const manifest = {
  harnessVersion: rootPkg.version,
  desktopVersion: JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')).version,
  bundledAt: new Date().toISOString(),
  contentSha256: hashBundledContent(outRoot),
  method: 'trimmed-monorepo-source',
  buildProvenance,
}
writeFileSync(join(outRoot, '.bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
assertPreparedBundle(outRoot)
verifyPreparedBuild(repoRoot)

console.log(`bundle-harness-source: wrote ${outRoot}`)
console.log(`bundle-harness-source: sha256=${manifest.contentSha256}`)
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  if (process.argv[2] === '--check') {
    assertPreparedBundle(outRoot)
    verifyPreparedBuild(repoRoot)
  }
  else main()
}
