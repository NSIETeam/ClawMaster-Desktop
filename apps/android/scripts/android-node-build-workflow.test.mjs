import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../../../.github/workflows/android-cloud-validation.yml', import.meta.url), 'utf8')

test('Android runtime workflow builds the production Node target without cctest', () => {
  assert.match(workflow, /Guard the production Node build target[\s\S]*?android-node-build-workflow\.test\.mjs/u)
  assert.match(workflow, /make -C out BUILDTYPE=Release V=0 node -j"\$\(nproc\)"/u)
  assert.doesNotMatch(workflow, /^\s*make\s+-j/mu)
  assert.match(workflow, /test -x "\$node"[\s\S]*?llvm-readelf[\s\S]*?if any\(value < 16384 for value in alignment\):/u)
  assert.match(workflow, /linker64 \/data\/local\/tmp\/clawmaster-node/u)
})
