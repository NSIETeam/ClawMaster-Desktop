/**
 * Bundle a trimmed harness monorepo slice for the Tauri installer.
 *
 * Ships source + pre-built lib/dist artifacts. When the full-core install
 * succeeds (default), the payload also carries its production node_modules
 * (hoisted, symlink-free) plus a staged Node/pnpm runtime, so the installer
 * runs fully offline and the provisioner executes the core in place. When the
 * install is skipped or fails non-strictly, the payload stays source-only and
 * first-run provisioning falls back to `pnpm install --prod` against it.
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, globSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  'frontends/graph-memory',
  'frontends/office',
  'frontends/rpa',
  'frontends/updates',
  'frontends/voice',
  'frontends/pdf',
  'frontends/feishu-docs',
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
    // The digest covers the source payload; an installed full core's
    // dependency tree is derived from the lockfile and never hashed.
    if (entry.isDirectory() && entry.name === 'node_modules') continue
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
      // Dependency executables are pnpm's symlinked .bin entries inside
      // node_modules; a symlink anywhere else in the source payload is a bug.
      if (entry.isSymbolicLink() && !path.includes(`${sep}node_modules${sep}`)) {
        throw new Error(`Prepared payload contains a symbolic link: ${path}`)
      }
      if (entry.isDirectory()) {
        // A full-core payload carries its installed dependency tree — at the
        // workspace root and linked into each workspace package (the hoisted
        // node_modules layout holds package-local directories too, marked at
        // the root with pnpm's completion marker). An uninstalled tree is
        // still a bug, as is any other excluded directory name.
        if (entry.name === 'node_modules') {
          if (!existsSync(join(root, 'node_modules', '.modules.yaml'))) {
            throw new Error(`Prepared payload contains an uninstalled node_modules directory: ${path}`)
          }
          continue
        }
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
      '@clawmaster/dsh-graph-memory': 'workspace:*',
      '@clawmaster/dsh-office': 'workspace:*',
      '@clawmaster/dsh-rpa': 'workspace:*',
      '@clawmaster/dsh-voice': 'workspace:*',
      '@clawmaster/dsh-pdf': 'workspace:*',
      '@clawmaster/dsh-feishu-docs': 'workspace:*',
      '@clawmaster/dsh-updates': 'workspace:*',
    },
  }
}

/**
 * Declare the desktop-owned insertion layer without changing the published updater module.
 * @param {object} manifest - Original updater package metadata copied into the desktop payload.
 * @returns {object} Desktop-only bundle metadata preserving dependencies and exports.
 */
export function withDesktopUpdateBundle(manifest) {
  if (manifest.name !== '@clawmaster/dsh-updates' || manifest.version !== '0.1.2') throw new Error('Desktop requires the reviewed updater package 0.1.2')
  return { ...manifest, dsh: { ...manifest.dsh, bundle: { patch: './desktop.cordis.patch.yml' } } }
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
  execFileSync(process.execPath, [join(repoRoot, 'frontends/graph-memory/scripts/build.mjs'), '--check'], {
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
  for (const frontend of ['voice', 'pdf', 'feishu-docs', 'updates']) {
    execFileSync(process.execPath, [join(repoRoot, `frontends/${frontend}/scripts/build.mjs`), '--check'], {
      cwd: repoRoot,
      stdio: 'inherit',
    })
  }
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
    if (!existsSync(join(repoRoot, 'frontends/graph-memory/dist', name))) {
      throw new Error('ClawMaster Graph Memory build missing. Run: node frontends/graph-memory/scripts/build.mjs')
    }
    for (const frontend of ['voice', 'pdf']) {
      if (!existsSync(join(repoRoot, `frontends/${frontend}/dist`, name))) {
        throw new Error(`ClawMaster ${frontend} build missing. Run: node frontends/${frontend}/scripts/build.mjs`)
      }
    }
  }
  if (!existsSync(join(repoRoot, 'frontends/guard/dist/index.js'))) {
    throw new Error('ClawMaster guard build missing. Run: node frontends/guard/scripts/build.mjs')
  }
  if (!existsSync(join(repoRoot, 'frontends/rpa/dist/index.js'))) {
    throw new Error('ClawMaster RPA build missing. Run: node frontends/rpa/scripts/build.mjs')
  }
  // Feishu Docs is host-only by design: it exposes tools and routes, so it has no client bundle.
  if (!existsSync(join(repoRoot, 'frontends/feishu-docs/dist/index.js'))) {
    throw new Error('ClawMaster Feishu Docs build missing. Run: node frontends/feishu-docs/scripts/build.mjs')
  }
  // The updater is host-only as well: its installer and maintenance entries are separate inputs.
  for (const name of ['index.js', 'install.mjs', 'maintenance.mjs']) {
    if (!existsSync(join(repoRoot, 'frontends/updates/dist', name))) {
      throw new Error('ClawMaster updater build missing. Run: node frontends/updates/scripts/build.mjs')
    }
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

/**
 * Install the bundle's production dependencies in place so the installer runs
 * fully offline. The hoisted node-linker keeps the packaged tree symlink-free,
 * which NSIS/DMG/DEB resource copying requires. The install resolves the
 * workspace manifests injected above and rewrites pnpm-lock.yaml to match, so
 * it MUST run before the payload digest is computed and the lockfile must not
 * be restored afterwards (an install with --frozen-lockfile against the
 * shipped tree is exactly what the compatibility suite verifies). Skipped
 * entirely when DSH_BUNDLE_FULL_CORE=0. Failure removes node_modules again
 * and is fatal only when DSH_REQUIRE_FULL_CORE=1; otherwise the payload stays
 * source-only and first-run provisioning falls back to its online install.
 * @param {string} root - Prepared harness workspace.
 * @returns {void}
 */
function installBundledCore(root) {
  if (process.env.DSH_BUNDLE_FULL_CORE === '0') {
    console.log('bundle-harness-source: full-core install disabled (DSH_BUNDLE_FULL_CORE=0)')
    return
  }
  const strict = process.env.DSH_REQUIRE_FULL_CORE === '1'
  const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  console.log('bundle-harness-source: installing bundled core dependencies (pnpm install --prod, hoisted)')
  const result = spawnSync(pnpmBin, ['install', '--prod', '--no-frozen-lockfile', '--config.node-linker=hoisted', '--config.confirmModulesPurge=false'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  const failed = result.error !== undefined || result.status !== 0
  const installed = existsSync(join(root, 'node_modules', '.modules.yaml'))
  if (installed) {
    // Pruning removes packages that `node_modules/.bin` shims point at, so it
    // must run before the dangling-link sweep or those shims survive as broken
    // links and the Tauri resource walk rejects the payload directory.
    pruneInstalledCore(root)
    materializeSymlinks(root)
  }
  if (!failed && !installed) {
    console.warn('bundle-harness-source: install finished without pnpm completion markers')
  }
  if (failed || !installed) {
    const detail = result.error !== undefined ? String(result.error) : `exit ${result.status}`
    rmSync(join(root, 'node_modules'), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    if (strict) throw new Error(`bundled core dependency install failed: ${detail}`)
    console.warn(`bundle-harness-source: full-core install failed (${detail}); shipping source-only payload`)
    return
  }
  console.log('bundle-harness-source: bundled core dependencies installed')
}

/**
 * Dependency packages removed from the shipped core's node_modules. None of
 * them is referenced by a static import anywhere in the shipped lib/dist
 * trees (verified per release):
 *
 * - @openai/codex and @anthropic-ai/claude-agent-sdk — external subagent
 *   backends the product does not ship; the product's in-process subagent
 *   backends remain.
 * - mermaid/@mermaid-js/react-icons/typescript/es-toolkit/openai/@google/
 *   playwright-core/@opentelemetry — build-time or optional-integration
 *   weight; every consumer bundles or lazy-loads them.
 *
 * Deliberately kept: @earendil-works/pi-ai (the LLM provider layer),
 * sherpa-onnx + @img (voice and image natives), pdf-lib, the office editor
 * runtime, and node-pty for the current platform.
 *
 * A released installer must not carry either external subagent SDK, so
 * entries are added here only together with evidence that nothing in the
 * payload imports them.
 */
export const PRUNED_DEPENDENCY_PACKAGES = Object.freeze([
  '@openai',
  '@anthropic-ai',
  'mermaid',
  '@mermaid-js',
  'react-icons',
  'typescript',
  'es-toolkit',
  'openai',
  '@google',
  'playwright-core',
  '@opentelemetry',
])

/**
 * Delete {@link PRUNED_DEPENDENCY_PACKAGES} from an installed core and drop
 * node-pty prebuilds for other platforms. Missing entries are tolerated: a
 * pruned scope may be absent because the workspace never depended on it.
 * @param {string} root - Installed harness workspace.
 * @returns {void}
 */
export function pruneInstalledCore(root) {
  const modules = join(root, 'node_modules')
  const prunedPackages = PRUNED_DEPENDENCY_PACKAGES
  let bytes = 0
  for (const name of prunedPackages) {
    const path = join(modules, name)
    if (!existsSync(path)) continue
    bytes += duEstimate(path)
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
  bytes += trimForeignPrebuilds(join(modules, 'node-pty', 'prebuilds'))
  console.log(`bundle-harness-source: pruned unused dependency packages (${(bytes / 1048576).toFixed(1)} MiB)`)
}

function duEstimate(path) {
  let total = 0
  const walk = dir => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(child)
        continue
      }
      try {
        total += statSync(child).size
      } catch {}
    }
  }
  walk(path)
  return total
}

/** Remove node-pty prebuilds for platforms other than the build target. */
function trimForeignPrebuilds(prebuilds) {
  if (!existsSync(prebuilds)) return 0
  const platformKey = `${process.platform}-${process.arch}`
  let bytes = 0
  for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name === platformKey) continue
    const path = join(prebuilds, entry.name)
    bytes += duEstimate(path)
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
  return bytes
}

/**
 * Drop dangling symlinks inside the installed dependency tree — typically
 * another platform's optional native binaries. Live links (pnpm's virtual
 * store and circular workspace pairs) are load-bearing: the hoisted layout
 * of a workspace monorepo keeps packages in per-package node_modules linked
 * into the store, so removing them breaks resolution. Consumers of the
 * payload must copy it link-preserving (cp -R, tar) instead of
 * dereferencing.
 * @param {string} root - Installed harness workspace.
 * @returns {void}
 */
function materializeSymlinks(root) {
  let dropped = 0
  const walk = dir => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        if (existsSync(path)) continue
        rmSync(path, { force: true, maxRetries: 3, retryDelay: 200 })
        dropped += 1
        continue
      }
      if (entry.isDirectory()) walk(path)
    }
  }
  walk(root)
  console.log(`bundle-harness-source: dropped ${dropped} dangling symlinks`)
}

/**
 * Remove debug-only payload weight (sourcemaps, tsbuildinfo, caches). None of
 * it is consulted at runtime; verification hashes are computed before pruning.
 * @param {string} root - Bundled harness workspace, installed or source-only.
 * @returns {void}
 */
function pruneBundledTree(root) {
  let files = 0
  let bytes = 0
  const walk = dir => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name === '.cache') {
          rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
          continue
        }
        walk(path)
        continue
      }
      if (/\.(?:map|tsbuildinfo)$/u.test(entry.name)) {
        bytes += statSync(path).size
        files += 1
        rmSync(path, { force: true })
      }
    }
  }
  walk(root)
  console.log(`bundle-harness-source: pruned ${files} map/tsbuildinfo files (${(bytes / 1048576).toFixed(1)} MiB) and .cache directories`)
}

/**
 * Stage the per-platform runtime next to the harness payload: the Node binary
 * running this script (setup-node's official build is self-contained) and, if
 * DSH_PNPM_CJS points at one, the pnpm entry the provisioner wires into the
 * path bridge for offline `dsh plugin` support.
 * @returns {void}
 */
function stageBundledRuntime() {
  const runtimeRoot = join(desktopRoot, 'bundled', 'runtime')
  const nodeDir = join(runtimeRoot, 'node')
  // Mirror the provisioner's node_binary_path layout: node.exe at the root on
  // Windows, bin/node elsewhere.
  const nodeDest = process.platform === 'win32'
    ? join(nodeDir, 'node.exe')
    : join(nodeDir, 'bin', 'node')
  mkdirSync(dirname(nodeDest), { recursive: true })
  copyFileSync(process.execPath, nodeDest)
  if (process.platform !== 'win32') chmodSync(nodeDest, 0o755)
  // macOS setup-node ships a universal binary; each installer only needs its
  // own slice (halves the staged runtime and the installer size).
  if (process.platform === 'darwin') {
    const lipo = spawnSync('/usr/bin/lipo', ['-thin', process.arch, '-output', nodeDest, nodeDest])
    if (lipo.status === 0) console.log('bundle-harness-source: staged node thinned to', process.arch)
  }
  let pnpmStaged = false
  const pnpmCjs = process.env.DSH_PNPM_CJS
  if (pnpmCjs && existsSync(pnpmCjs)) {
    mkdirSync(join(runtimeRoot, 'pnpm'), { recursive: true })
    copyFileSync(pnpmCjs, join(runtimeRoot, 'pnpm', 'pnpm.cjs'))
    pnpmStaged = true
  }
  console.log(`bundle-harness-source: staged runtime node=${nodeDest} pnpm=${pnpmStaged ? 'bundled' : 'not bundled'}`)
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
for (const frontend of ['dsh', 'guard', 'notes', 'graph-memory', 'office', 'rpa', 'updates', 'voice', 'pdf', 'feishu-docs']) {
  for (const name of ['package.json', 'dist', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    copyTree(join(repoRoot, 'frontends', frontend, name), join(outRoot, 'frontends', frontend, name))
  }
}
{
  const updaterManifestPath = join(outRoot, 'frontends/updates/package.json')
  writeFileSync(updaterManifestPath, `${JSON.stringify(withDesktopUpdateBundle(JSON.parse(readFileSync(updaterManifestPath, 'utf8'))), null, 2)}\n`)
  copyTree(join(desktopRoot, 'updates/cordis.patch.yml'), join(outRoot, 'frontends/updates/desktop.cordis.patch.yml'))
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

// Prune debug-only weight, then install the dependency tree. Both happen
// BEFORE the payload digest: the digest must describe the shipped tree, and
// the digest walk skips node_modules entirely, so the installed core only
// contributes its rewritten pnpm-lock.yaml.
pruneBundledTree(outRoot)
installBundledCore(outRoot)
stageBundledRuntime()

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
