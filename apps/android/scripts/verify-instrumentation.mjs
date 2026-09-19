/** adb's exit status alone does not establish that its instrumentation test passed. */
import { readFileSync } from 'node:fs'

const output = readFileSync(process.argv[2], 'utf8')
if (!/OK \(1 test\)/.test(output) || /FAILURES!!!|INSTRUMENTATION_FAILED|shortMsg=|Process crashed/.test(output)) {
  throw new Error('The one-test upgrade instrumentation did not pass')
}
console.log('Upgrade instrumentation passed (1 test).')
