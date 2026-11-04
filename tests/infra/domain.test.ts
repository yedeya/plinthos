import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostedZoneId } from '../../infra/domain';
import { fakeZoneId, installFakeSst, type FakeSst, type RecordedResource } from './fake-sst';
import { deploymentEnv, runStack, stackSources } from './harness';

/**
 * The deployment's own domain (#293, `infra/domain.ts`). With `PLINTHOS_DOMAIN` unset the stack
 * is as it was: both distributions on their `cloudfront.net` hosts ([PLAT-17]). Set, the admin's
 * `sst.aws.Nextjs` gets the domain, with the DNS of the hosted zone named after it, which the
 * stack looks up and never manages ([PLAT-18]). From that one `domain`, SST's `Cdn` makes the
 * certificate in `us-east-1` through its own provider, validates it by DNS in that zone, puts the
 * name on the distribution with `TLSv1.2_2021`, adds the A and AAAA alias records, and makes the
 * admin's viewer-request function answer 403 to a `cloudfront.net` host ([PLAT-19]). The fake
 * stands in for SST, so those are read from its source (`.sst/platform/src/components/aws/cdn.ts`
 * and `ssr-site.ts`, `sst` 4.17.2) and checked on a deployment (#293, Issue D), not here. The
 * catalogue's name is Issue B's.
 */

let fake: FakeSst;
beforeEach(() => {
  fake = installFakeSst();
});
afterEach(() => fake.uninstall());

const DOMAIN = 'plinthos.example.com';

function admin(): RecordedResource {
  const found = fake.ofType('sst:aws:Nextjs');
  expect(found).toHaveLength(1);
  return found[0] as RecordedResource;
}

/** Every resource a domain would bring: a certificate, its validation, a DNS record, a zone or a provider. */
function domainResources(): RecordedResource[] {
  return fake.resources.filter(({ type }) => /^aws:(acm|route53)\//.test(type) || type.startsWith('pulumi:providers:'));
}

describe('with no domain', () => {
  it('[PLAT-17] the stack creates no certificate, DNS record or alias, and both distributions keep CloudFront’s own host and certificate', () => {
    for (const env of [deploymentEnv(), deploymentEnv({ PLINTHOS_DOMAIN: '  ' })]) {
      fake.uninstall();
      fake = installFakeSst();
      const { outputs } = runStack(fake, env);
      expect(admin().args).not.toHaveProperty('domain');
      expect(domainResources()).toEqual([]);
      expect(fake.zoneLookups).toEqual([]);
      for (const distribution of fake.ofType('aws:cloudfront/distribution:Distribution')) {
        expect(distribution.args.viewerCertificate, distribution.name).toEqual({ cloudfrontDefaultCertificate: true });
        expect(distribution.args.aliases ?? [], distribution.name).toEqual([]);
      }
      expect(outputs.adminUrl).toBe('https://admin.fake.cloudfront.test');
    }
  });
});

describe('with a domain', () => {
  it('[PLAT-18] the admin answers at the domain itself, through the DNS of the hosted zone whose name is the domain', async () => {
    runStack(fake, deploymentEnv({ PLINTHOS_DOMAIN: ` ${DOMAIN.toUpperCase()} ` }));
    const domain = admin().args.domain as { name: string; dns: { provider: string; args: { zone: { value: Promise<string> } } } };
    expect(Object.keys(domain).sort()).toEqual(['dns', 'name']);
    // No alias, redirect or certificate of the stack's own: one name, and SST's certificate for it.
    expect(domain.name).toBe(DOMAIN);
    expect(domain.dns.provider).toBe('aws');
    expect(Object.keys(domain.dns.args)).toEqual(['zone']);
    // The zone is looked up by its exact name, public only, not by the nearest zone above the record.
    await expect(domain.dns.args.zone.value).resolves.toBe(fakeZoneId(DOMAIN));
    expect(fake.zoneLookups).toEqual([{ name: DOMAIN, privateZone: false }]);
  });

  it('[PLAT-18] a deploy that finds no hosted zone of that name fails and says so', async () => {
    runStack(fake, deploymentEnv({ PLINTHOS_DOMAIN: 'bricks.example.org' }));
    const zone = (admin().args.domain as { dns: { args: { zone: { value: Promise<string> } } } }).dns.args.zone.value;
    await expect(zone).rejects.toThrow(/No public Route 53 hosted zone named bricks\.example\.org/);
    await expect(hostedZoneId('bricks.example.org')).rejects.toThrow(/docs\/deploy\.md, Your own domain/);
    // Not the zone above it either: a zone for plinthos.example.com doesn't serve admin.plinthos.example.com.
    await expect(hostedZoneId(`admin.${DOMAIN}`)).rejects.toThrow(/No public Route 53 hosted zone named admin\.plinthos\.example\.com/);
  });

  it('[PLAT-18] the stack never creates, changes or deletes the hosted zone: it only looks it up', () => {
    runStack(fake, deploymentEnv({ PLINTHOS_DOMAIN: DOMAIN }));
    expect(fake.ofType('aws:route53/zone:Zone')).toEqual([]);
    for (const { path, source } of stackSources()) {
      expect(source, path).not.toMatch(/route53\.(Zone|ZoneAssociation|DelegationSet|HostedZoneDnsSec)\b/);
    }
  });

  it('[PLAT-19] adminUrl, the address the smoke check probes and CORS allows, is https:// followed by the domain', () => {
    const { outputs } = runStack(fake, deploymentEnv({ PLINTHOS_DOMAIN: DOMAIN }));
    expect(outputs.adminUrl).toBe(`https://${DOMAIN}`);
    // SST adds the 403 for a `cloudfront.net` host to the viewer-request function whenever its
    // `domain` is set, ahead of nothing the admin needs: its own injection only sets two headers
    // and never answers a request itself ([AUTH-14]).
    const injection = (admin().args.edge as { viewerRequest: { injection: string } }).viewerRequest.injection;
    expect(injection).not.toMatch(/\breturn\b/);
    expect(admin().args.domain).toBeTruthy();
  });
});
