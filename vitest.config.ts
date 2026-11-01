import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // A focused test would silently drop every other one from the run, locally and in CI alike.
    allowOnly: false,
  },
});
