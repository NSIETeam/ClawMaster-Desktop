import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { pool: 'forks', include: ['seam/**/*.test.ts'] },
});
