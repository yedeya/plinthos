import type { Reporter, TestModule, TestRunEndReason, TestSpecification, Vitest } from 'vitest/node';

/**
 * Fails the run when any test was skipped or left as todo ([DEV-3]).
 *
 * The lint gate refuses the static ways to leave a test out, but a test can still skip itself
 * at runtime with `ctx.skip()`, or reach `.skip` through an alias the lint rule cannot follow.
 * Whatever the route, the test ends in the `skipped` state, so this reporter judges the outcome.
 *
 * A run filtered by test name, line, id or tag skips the tests it leaves out, so the check
 * stands aside for one, the same way Vitest decides a run is partial. `npm test` never filters.
 */
export class EveryTestRuns implements Reporter {
  private vitest: Vitest | undefined;
  private filtered = false;

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
  }

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
    const vitest = this.vitest;
    this.filtered =
      vitest?.getGlobalTestNamePattern() !== undefined ||
      Boolean(vitest?.config.tagsFilter?.length) ||
      specifications.some(
        (spec) => spec.testNamePattern || spec.testLines?.length || spec.testIds?.length || spec.testTagsFilter?.length,
      );
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>, _errors: unknown, reason: TestRunEndReason): void {
    if (this.filtered || reason === 'interrupted') return;
    const leftOut = testModules.flatMap((testModule) => [
      ...[...testModule.children.allSuites()]
        .filter((suite) => suite.state() === 'skipped')
        .map((suite) => `${testModule.relativeModuleId} > ${suite.fullName} (suite)`),
      ...[...testModule.children.allTests('skipped')].map((test) => `${testModule.relativeModuleId} > ${test.fullName}`),
    ]);
    if (leftOut.length === 0) return;
    process.exitCode = 1;
    this.vitest?.logger.error(
      [
        `\nEvery test runs ([DEV-3]): ${leftOut.length} left out of this run. Fix or delete each one instead.`,
        ...leftOut.map((name) => `  - ${name}`),
        '',
      ].join('\n'),
    );
  }
}
