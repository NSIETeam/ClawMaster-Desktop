/** Repository convenience command that dispatches the supported DSH control profile. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareControlProfile } from '../apps/desktop-tauri/scripts/desktop-defaults.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(new URL('../apps/cli/package.json', import.meta.url))
const { resolveDshHome } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-home-paths')).href)
await prepareControlProfile(root, resolveDshHome())
const child = spawn(process.execPath, [
  '--import', 'tsx/esm', fileURLToPath(new URL('../apps/cli/src/bin.ts', import.meta.url)),
  '--profile', 'clawmaster-control', ...process.argv.slice(2),
], { stdio: 'inherit', cwd: process.cwd(), env: process.env })
const interrupt = () => { child.kill('SIGINT') }
const terminate = () => { child.kill('SIGTERM') }
process.on('SIGINT', interrupt)
process.on('SIGTERM', terminate)
try {
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1))
  })
  process.exitCode = result
} finally {
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', terminate)
}
