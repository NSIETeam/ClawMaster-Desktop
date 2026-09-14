/**
 * Prepare Tauri frontend dist and bundled harness source tree.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { captureBuildSource, desktopBuildMode, PREPARED_PROVENANCE_PATH, recordPreparedBuild, verifyHarnessBuild } from './build-provenance.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repository = join(root, '..', '..')
const mode = desktopBuildMode()
const source = captureBuildSource(repository, mode)
verifyHarnessBuild(repository, mode)
rmSync(join(repository, PREPARED_PROVENANCE_PATH), { force: true })
const icons = spawnSync(process.execPath, [join(root, 'scripts', 'generate-icons.mjs')], {
  stdio: 'inherit', cwd: root,
})
if (icons.status !== 0) process.exit(icons.status ?? 1)
for (const name of ['dsh', 'guard', 'notes', 'office', 'rpa']) {
  const frontend = join(root, '..', '..', 'frontends', name)
  const frontendBuild = spawnSync(process.execPath, [join(frontend, 'scripts', 'build.mjs')], {
    stdio: 'inherit', cwd: frontend,
  })
  if (frontendBuild.status !== 0) process.exit(frontendBuild.status ?? 1)
}
const dist = join(root, 'dist')
mkdirSync(dist, { recursive: true })
cpSync(join(root, 'splash.html'), join(dist, 'splash.html'))
cpSync(join(root, 'shell.html'), join(dist, 'shell.html'))
cpSync(join(root, 'desktop-i18n.js'), join(dist, 'desktop-i18n.js'))
cpSync(join(root, '..', '..', 'frontends', 'dsh', 'src', 'clawmaster.svg'), join(dist, 'app-icon.svg'))
cpSync(join(root, '..', '..', 'frontends', 'dsh', 'src', 'clawmaster-dark.svg'), join(dist, 'app-icon-dark.svg'))
recordPreparedBuild(repository, source, mode)

const bundleScript = join(root, 'scripts', 'bundle-harness-source.mjs')
const result = spawnSync(process.execPath, [bundleScript], { stdio: 'inherit', cwd: root })
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

if (!existsSync(join(root, 'bundled', 'harness', '.bundle-manifest.json'))) {
  throw new Error('bundled harness manifest missing after bundle-harness-source.mjs')
}
