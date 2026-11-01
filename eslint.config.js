import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// The test runner's ways of leaving a test out of a run. A test that needs the database fails
// without one rather than being skipped ([DEV-3]), and no other test is left out either.
const leavesTestOut = ['it', 'test', 'describe'].flatMap((object) =>
  ['skip', 'skipIf', 'runIf', 'todo', 'only'].map((property) => ({
    object,
    property,
    message: 'Every test runs: fix or delete it instead ([DEV-3]).',
  })),
);

export default tseslint.config(
  { ignores: ['node_modules/', 'coverage/', '.qa-pr/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  {
    files: ['tests/**'],
    rules: { 'no-restricted-properties': ['error', ...leavesTestOut] },
  },
);
