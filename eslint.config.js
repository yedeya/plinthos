import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// The test runner's ways of leaving a test out of a run. A test that needs the database fails
// without one rather than being skipped ([DEV-3]), and no other test is left out either. This is
// the static half: tests/support/every-test-runs.ts fails `npm test` on whatever slips past it.
const TEST_API = '^(it|test|describe|suite)$';
const MODIFIER = '^(skip|skipIf|runIf|todo|only)$';
const HOOK_OR_TEST = `:matches(CallExpression[callee.name=/^(it|test|beforeEach|afterEach)$/], CallExpression[callee.object.name=/^(it|test)$/])`;
const leavesTestOut = [
  {
    // `it.skip`, and the same modifier up to two links further down a chain: `it.concurrent.skip`,
    // `describe.sequential.concurrent.only`.
    selector: `MemberExpression[property.name=/${MODIFIER}/]:matches([object.name=/${TEST_API}/], [object.object.name=/${TEST_API}/], [object.object.object.name=/${TEST_API}/])`,
    message: 'Every test runs: fix or delete it instead ([DEV-3]).',
  },
  ...['it', 'test', 'describe', 'suite'].map((name) => ({
    selector: `ImportDeclaration[source.value='vitest'] > ImportSpecifier[imported.name='${name}'][local.name!='${name}']`,
    message: `Import \`${name}\` under its own name, so the gate can see its modifiers ([DEV-3]).`,
  })),
  {
    selector: "ImportDeclaration[source.value='vitest'] > ImportNamespaceSpecifier",
    message: 'Import the test API by name, so the gate can see its modifiers ([DEV-3]).',
  },
  {
    // `(ctx) => { ctx.skip(); }` in a test or a hook.
    selector: `${HOOK_OR_TEST} CallExpression[callee.property.name='skip']`,
    message: 'A test does not skip itself: fail it instead ([DEV-3]).',
  },
  {
    // `({ skip }) => skip()`: a function that takes `skip` from its argument.
    selector: ":function > ObjectPattern > Property[key.name='skip']",
    message: 'A test does not skip itself: fail it instead ([DEV-3]).',
  },
];

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
    rules: { 'no-restricted-syntax': ['error', ...leavesTestOut] },
  },
);
