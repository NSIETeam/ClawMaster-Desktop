import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('upgrade acceptance requires the one-test success result and rejects crashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawmaster-upgrade-output-'))
  try {
    const file = join(root, 'output.txt')
    for (const [output, accepted] of [
      ['Time: 1.1\nOK (1 test)\nINSTRUMENTATION_CODE: -1', true],
      ['', false],
      ['INSTRUMENTATION_CODE: -1', false],
      ['OK (1 test)\nINSTRUMENTATION_FAILED: Process crashed', false],
      ['FAILURES!!!\nTests run: 1, Failures: 1', false],
    ]) {
      writeFileSync(file, output)
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./verify-instrumentation.mjs', import.meta.url)), file], { encoding: 'utf8', timeout: 10000 })
      assert.ifError(result.error)
      assert.equal(result.signal, null)
      assert.equal(result.status === 0, accepted)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
