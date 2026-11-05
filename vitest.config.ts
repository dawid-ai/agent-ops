import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against the package sources, so they need no build first.
    alias: {
      '@agent-ops/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@agent-ops/supervisor': fileURLToPath(
        new URL('./packages/supervisor/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // A hang guard, not a speed limit: the git-heavy tests (mirror, sync, supervisor) take up to
    // ~20 s each on Windows when every worker runs at once.
    testTimeout: 60000,
    setupFiles: ['./vitest.setup.ts'],
  },
});
