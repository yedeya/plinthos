// The SST app (AGENTS.md's stack): one stage, `production`, in the one region the deployment
// configures ([PLAT-1], [PLAT-2]). Its resources live in `infra/` as typed modules the tests
// import, and `infra/stack.ts` composes them. `docs/deploy.md` is how to deploy it.
//
// Its types come from `.sst/platform`, which `npm run typecheck` installs through
// `sst.types.config.ts` before `infra/tsconfig.json` checks this file.
export default $config({
  async app(input) {
    const { AWS_PROVIDER_VERSION, readDeploymentConfig, resolveStage } = await import('./infra/config');
    // Both refuse before anything is created, the state bucket included.
    resolveStage(input.stage);
    const { region } = readDeploymentConfig(process.env);
    return {
      name: 'plinthos',
      home: 'aws',
      // Data outlives a teardown: `sst remove` keeps every bucket and table (docs/deploy.md).
      removal: 'retain',
      providers: { aws: { region: region as aws.Region, version: AWS_PROVIDER_VERSION } },
    };
  },
  async run() {
    const { readDeploymentConfig } = await import('./infra/config');
    const { defineStack } = await import('./infra/stack');
    return defineStack(readDeploymentConfig(process.env), process.env);
  },
});
