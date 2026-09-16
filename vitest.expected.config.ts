import { availableParallelism } from 'node:os'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

/** Owner-local assembled expected-output tests that do not use a recorded session as their input. */
const rawExpectedWorkers = process.env.DSH_EXPECTED_MAX_WORKERS
const expectedWorkers = rawExpectedWorkers === undefined || rawExpectedWorkers === ''
  ? Math.min(5, availableParallelism())
  : Number(rawExpectedWorkers)
if (!Number.isSafeInteger(expectedWorkers) || expectedWorkers < 1) {
  throw new Error(`DSH_EXPECTED_MAX_WORKERS must be a positive integer, got ${JSON.stringify(rawExpectedWorkers)}`)
}

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-proxy-environment.ts', './scripts/test-invariants.ts'],
    include: [
      'apps/cli/tests/**/*.expected.e2e.ts',
    ],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    maxWorkers: expectedWorkers,
  },
})
