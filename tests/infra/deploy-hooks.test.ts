import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readRepoFile, repoRoot } from '../support/repo-file';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface CompositeAction {
  inputs: Record<string, { default?: string }>;
  runs: { using: string; steps: Step[] };
}

function hook(name: 'build' | 'deploy' | 'smoke'): CompositeAction {
  return parse(readRepoFile(`.github/actions/${name}/action.yml`)) as CompositeAction;
}

/** Every string a step holds: its command, its condition, its action and every value it passes. */
function text(step: Step): string {
  return [step.run, step.if, step.uses, ...Object.values(step.with ?? {}), ...Object.values(step.env ?? {})].join('\n');
}

// What reaches a cloud credential: the AWS credential action, an OIDC token request, an STS call.
const CREDENTIAL = /configure-aws-credentials|ACTIONS_ID_TOKEN_REQUEST|assume-role|id-token/;

describe('the deploy lane hooks', () => {
  it('[PLAT-4] fill every input the lane passes (docs/lanes.md, "The hooks")', () => {
    expect(Object.keys(hook('build').inputs).sort()).toEqual(['output', 'release', 'sha']);
    expect(Object.keys(hook('deploy').inputs).sort()).toEqual(
      ['artifact', 'environment', 'environments', 'probe', 'release', 'role', 'sha'],
    );
    expect(Object.keys(hook('smoke').inputs).sort()).toEqual(['environment', 'release', 'role']);
    for (const name of ['build', 'deploy', 'smoke'] as const) expect(hook(name).runs.using).toBe('composite');
  });

  it('[PLAT-4] name no context a composite action cannot read: no vars, no secrets', () => {
    const dir = join(repoRoot, '.github/actions');
    for (const action of readdirSync(dir)) {
      const steps = (parse(readRepoFile(`.github/actions/${action}/action.yml`)) as CompositeAction).runs.steps;
      for (const step of steps) expect(text(step), `${action}: ${step.name}`).not.toMatch(/\$\{\{[^}]*\b(?:vars|secrets)\./);
    }
  });

  it('[PLAT-4] the build hook builds the OpenNext output with no credential, and copies it into its output', () => {
    const steps = hook('build').runs.steps;
    for (const step of steps) expect(text(step), step.name).not.toMatch(CREDENTIAL);
    expect(steps.some((step) => /\bsst\s+(deploy|remove|secret)/.test(step.run ?? ''))).toBe(false);
    expect(steps[0]?.uses).toBe('./.github/actions/project-setup');
    expect(steps[0]?.with?.database).toBe('false');
    expect(steps.map((step) => step.run?.trim())).toContain('npm run build');
    const copy = steps.find((step) => step.env?.OUTPUT === '${{ inputs.output }}');
    expect(copy?.run).toContain('cp -R .open-next "$OUTPUT/.open-next"');
    expect(copy?.run).toContain('cp .next/BUILD_ID .next/routes-manifest.json .next/prerender-manifest.json "$OUTPUT/.next/"');
  });

  it('[PLAT-4] npm run build is OpenNext’s build of the Next.js app', () => {
    const pkg = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toBe('open-next build');
    expect(readRepoFile('open-next.config.ts')).toMatch(/buildCommand:\s*'npx next build'/);
  });

  it('[PLAT-4] with probe true, the deploy hook only runs the probe, which writes the lane’s answer file', () => {
    const steps = hook('deploy').runs.steps;
    const probe = steps.filter((step) => step.if === "inputs.probe == 'true'");
    expect(probe).toHaveLength(1);
    expect(probe[0]?.run).toBe('bash "$GITHUB_ACTION_PATH/probe.sh"');
    expect(probe[0]?.env?.ENVIRONMENTS).toBe('${{ inputs.environments }}');
    for (const step of steps.filter((s) => s !== probe[0])) expect(step.if, step.name).toBe("inputs.probe != 'true'");
    expect(readRepoFile('.github/actions/deploy/probe.sh')).toContain('/kanon-deploy-probe.json');
  });

  it('[PLAT-4] the deploy hook installs before it holds a credential, then deploys the stage production and builds nothing', () => {
    const steps = hook('deploy').runs.steps.filter((step) => step.if === "inputs.probe != 'true'");
    const install = steps.findIndex((step) => step.uses === './.github/actions/project-setup');
    const credential = steps.findIndex((step) => step.uses?.startsWith('aws-actions/configure-aws-credentials@'));
    const deploy = steps.findIndex((step) => step.run?.trim() === 'npx sst deploy --stage production');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(credential).toBeGreaterThan(install);
    expect(deploy).toBeGreaterThan(credential);
    expect(steps[credential]?.with?.['role-to-assume']).toBe('${{ env.AWS_DEPLOY_ROLE_ARN }}');
    expect(steps[credential]?.with?.['aws-region']).toBe('${{ env.PLINTHOS_AWS_REGION }}');
    for (const step of steps) {
      expect(step.run ?? '', step.name).not.toMatch(/npm run build|(?:^|\s)(?:npx\s+)?(?:open-next|next)\s+build/m);
    }
    const restore = steps.find((step) => step.env?.ARTIFACT === '${{ inputs.artifact }}' && /cp -R/.test(step.run ?? ''));
    expect(restore?.run).toContain('cp -R "$ARTIFACT/.open-next" .open-next');
  });

  it('[PLAT-4] the smoke hook fails the deploy unless /health/live answers 200', () => {
    const [check, ...rest] = hook('smoke').runs.steps;
    expect(rest).toEqual([]);
    const run = check?.run ?? '';
    expect(run).toContain('/health/live');
    expect(run).toContain('"$code" = 200');
    expect(run).toMatch(/exit 1\s*$/);
    for (const step of hook('smoke').runs.steps) expect(text(step)).not.toMatch(CREDENTIAL);
  });
});
