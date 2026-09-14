/**
 * Notes compiled-client interactions use the repository's React and jsdom runtime.
 *
 * A caller that exports NODE_ENV=production must not leak into these tests: React's
 * production build omits `act`, which @testing-library/react requires, so the whole
 * suite fails with "act(...) is not supported in production builds of React".
 */
process.env.NODE_ENV = 'test';

import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const webRequire = createRequire(`${root}apps/web/package.json`);
export default defineConfig({
  root,
  resolve: { alias: [
    { find: /^react(\/.*)?$/, replacement: `${dirname(webRequire.resolve('react/package.json'))}$1` },
    { find: /^react-dom(\/.*)?$/, replacement: `${dirname(webRequire.resolve('react-dom/package.json'))}$1` },
  ] },
  test: {
    environment: 'jsdom',
    pool: 'forks',
    env: { NODE_ENV: 'test' },
    include: ['frontends/notes/tests/client.spec.mjs', 'frontends/notes/tests/rich-editor.spec.mjs'],
  },
});
