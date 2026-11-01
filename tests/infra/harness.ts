import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readDeploymentConfig, SECRETS } from '../../infra/config';
import { defineStack } from '../../infra/stack';
import { readRepoFile, repoRoot } from '../support/repo-file';
import { secretsEnv, type FakeSst } from './fake-sst';

/** The stack's own source: `sst.config.ts` and every module under `infra/`. */
export function stackSources(): { path: string; source: string }[] {
  const modules = readdirSync(join(repoRoot, 'infra')).filter((file) => file.endsWith('.ts'));
  return ['sst.config.ts', ...modules.map((file) => `infra/${file}`)].map((path) => ({ path, source: readRepoFile(path) }));
}

/** A deployment's environment with every SST secret set, and the given configuration values. */
export function deploymentEnv(values: Record<string, string> = {}): Record<string, string> {
  return {
    PLINTHOS_AWS_REGION: 'eu-central-1',
    ...secretsEnv(SECRETS.map(({ name }) => name)),
    ...values,
  };
}

/** Runs the whole stack against the installed stand-ins, as `sst.config.ts`'s `run()` does. */
export function runStack(fake: FakeSst, env: Record<string, string> = deploymentEnv()) {
  const outputs = defineStack(readDeploymentConfig(env), env);
  return { outputs, fake };
}
