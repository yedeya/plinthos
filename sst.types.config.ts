// For the typecheck only: `npm run typecheck` runs `sst install` against this file so that
// `.sst/platform` (SST's types) exists without a deployment's configuration, and without AWS.
// `sst.config.ts` refuses to load without its region and stage ([PLAT-1], [PLAT-2]), which is
// right for every command that reaches AWS, and `sst install` reaches none.
//
// `home: 'local'` keeps any command run against this file away from AWS. Its providers must be
// `sst.config.ts`'s, at the same version; `tests/infra/stage-and-region.test.ts` holds the two
// together. Never deploy with it.
export default $config({
  async app() {
    const { AWS_PROVIDER_VERSION } = await import('./infra/config');
    return {
      name: 'plinthos-types',
      home: 'local',
      providers: { aws: { version: AWS_PROVIDER_VERSION } },
    };
  },
  async run() {
    throw new Error('sst.types.config.ts only installs the types: deploy with sst.config.ts (docs/deploy.md).');
  },
});
