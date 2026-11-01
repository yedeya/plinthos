import { configDefaults, defineConfig } from 'vitest/config';
import { EveryTestRuns } from './tests/support/every-test-runs.ts';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // A focused test would silently drop every other one from the run, locally and in CI alike.
    allowOnly: false,
    // Vitest's own reporters, and one that fails the run when a test was skipped ([DEV-3]).
    reporters: [...configDefaults.reporters, new EveryTestRuns()],
  },
});
