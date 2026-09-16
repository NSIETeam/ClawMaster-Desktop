/** Build the Host plugin and finite installer without runtime package-manager access. */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isBuiltin } from 'node:module'

const root = fileURLToPath(new URL('..', import.meta.url))
const common = {
  absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  write: false, legalComments: 'inline',
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
}
const outputs = []
for (const [entry, outfile, external] of [
  ['src/index.ts', 'dist/index.js', ['@threema/wasm-minisign-verify']],
  ['src/install.ts', 'dist/install.mjs', []],
  ['src/maintenance.ts', 'dist/maintenance.mjs', []],
]) {
  const result = await build({ ...common, entryPoints: [entry], outfile, external, metafile: true })
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && !isBuiltin(dependency.path) && !external.includes(dependency.path)) {
        throw new Error(`Unbundled installer dependency: ${dependency.path}`)
      }
    }
  }
  outputs.push(...result.outputFiles)
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
if (process.argv.includes('--check')) {
  for (const output of outputs) if (digest(await readFile(output.path)) !== digest(output.contents)) throw new Error(`Stale update artifact: ${output.path}`)
  console.log('Updater artifacts match source and pinned dependencies.')
} else {
  await mkdir(new URL('../dist/', import.meta.url), { recursive: true })
  for (const output of outputs) await writeFile(output.path, output.contents)
  console.log('Built updater Host and standalone installer.')
}
