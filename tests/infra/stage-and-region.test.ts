import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWS_PROVIDER_VERSION, DeploymentConfigError, resolveStage, SECRETS, STAGE } from '../../infra/config';
import { installFakeSst, secretsEnv, type FakeSst } from './fake-sst';
import { stackSources } from './harness';

interface AppConfig {
  name: string;
  home: string;
  removal?: string;
  providers: Record<string, { region?: string; version?: string }>;
}
interface SstConfig {
  app(input: { stage: string }): Promise<AppConfig>;
  run(): Promise<unknown>;
}

let fake: FakeSst;
beforeEach(() => {
  fake = installFakeSst();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});

async function sstConfig(path: '../../sst.config' | '../../sst.types.config'): Promise<SstConfig> {
  return (await import(path)).default as SstConfig;
}

describe('the stage', () => {
  it('[PLAT-1] is production, and resolveStage refuses every other name', () => {
    expect(STAGE).toBe('production');
    expect(resolveStage('production')).toBe('production');
    for (const stage of ['dev', 'staging', 'Production', 'production2', '']) {
      expect(() => resolveStage(stage)).toThrow(DeploymentConfigError);
      expect(() => resolveStage(stage)).toThrow(/only the stage "production"/);
    }
  });

  it('[PLAT-1] sst.config.ts refuses another stage in app(), before any resource or state exists', async () => {
    vi.stubEnv('PLINTHOS_AWS_REGION', 'eu-central-1');
    const config = await sstConfig('../../sst.config');
    await expect(config.app({ stage: 'dev' })).rejects.toThrow(/only the stage "production", not "dev"/);
    expect(fake.events).toEqual([]);
  });
});

describe('the region', () => {
  it('[PLAT-1] sst.config.ts deploys to exactly one region, the configured one, through one AWS provider', async () => {
    vi.stubEnv('PLINTHOS_AWS_REGION', 'ap-southeast-2');
    const app = await (await sstConfig('../../sst.config')).app({ stage: 'production' });
    expect(Object.keys(app.providers)).toEqual(['aws']);
    expect(app.providers.aws).toEqual({ region: 'ap-southeast-2', version: AWS_PROVIDER_VERSION });
    expect(app).toMatchObject({ name: 'plinthos', home: 'aws', removal: 'retain' });
  });

  it('[PLAT-1] sst.config.ts refuses to load with no region configured, before any resource or state exists', async () => {
    vi.stubEnv('PLINTHOS_AWS_REGION', '');
    const config = await sstConfig('../../sst.config');
    await expect(config.app({ stage: 'production' })).rejects.toThrow(/PLINTHOS_AWS_REGION/);
    expect(fake.events).toEqual([]);
  });

  it('[PLAT-1] no module creates a second AWS provider or deploys a component to other regions', async () => {
    for (const { path, source } of stackSources()) {
      expect(source, path).not.toMatch(/new\s+aws\.Provider\s*\(/);
      expect(source, path).not.toMatch(/\bregions\s*:/);
    }
    vi.stubEnv('PLINTHOS_AWS_REGION', 'eu-central-1');
    for (const [name, value] of Object.entries(secretsEnv(SECRETS.map(({ name }) => name)))) vi.stubEnv(name, value);
    await (await sstConfig('../../sst.config')).run();
    const admin = fake.ofType('sst:aws:Nextjs');
    expect(admin).toHaveLength(1);
    expect(admin[0]?.args).not.toHaveProperty('regions');
  });

  it('[PLAT-1] the types-only config installs the same providers at the same version, and never deploys', async () => {
    vi.stubEnv('PLINTHOS_AWS_REGION', 'eu-central-1');
    const real = await (await sstConfig('../../sst.config')).app({ stage: 'production' });
    const types = await (await sstConfig('../../sst.types.config')).app({ stage: 'types' });
    expect(Object.keys(types.providers)).toEqual(Object.keys(real.providers));
    expect(types.providers.aws?.version).toBe(real.providers.aws?.version);
    expect(types.home).toBe('local');
    await expect((await sstConfig('../../sst.types.config')).run()).rejects.toThrow(/only installs the types/);
  });
});
