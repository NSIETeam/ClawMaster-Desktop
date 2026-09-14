/** Build the command client and desktop bridge without bundling DSH service instances. */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/cli.ts', 'src/host.ts'],
  outdir: 'dist',
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false,
})
for (const output of result.outputFiles) {
  if (process.argv.includes('--check')) {
    const existing = await readFile(output.path).catch(error => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (!existing?.equals(output.contents)) throw new Error('ClawMaster control build is stale; run npm --prefix frontends/control run build')
  } else {
    await mkdir(new URL('../dist', import.meta.url), { recursive: true })
    await writeFile(output.path, output.contents)
  }
}
console.log('ClawMaster control artifacts match their sources.')
