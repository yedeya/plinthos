/**
 * The deployment's own domain, when `PLINTHOS_DOMAIN` sets one (#293, [PLAT-17], [PLAT-18]).
 *
 * The owner creates the Route 53 hosted zone whose name is the domain by hand, once, and delegates
 * it from the parent's DNS provider before the first deploy that sets the domain
 * (`docs/deploy.md`, *Your own domain*). The stack only looks it up: a zone it made would go with
 * `sst remove` and come back with other name servers, which would break the delegation unseen.
 * The lookup is by the zone's exact name and public zones only, never the nearest zone above a
 * record as `sst.aws.dns()` finds one without an id, so each record and each certificate's
 * validation lands in that one zone. A public hosted zone costs $0.50 a month while it exists,
 * set or unset (brief #293, §4); the lookup is free.
 */

/**
 * The id of the public hosted zone named `domain`. A deploy that finds none, or more than one,
 * fails here, naming the zone and the guide's section.
 */
export async function hostedZoneId(domain: string): Promise<string> {
  try {
    return (await aws.route53.getZone({ name: domain, privateZone: false })).zoneId;
  } catch (error) {
    throw new Error(
      `No public Route 53 hosted zone named ${domain} was found, or more than one: create it, delegate it from the parent domain, and check the delegation before deploying with PLINTHOS_DOMAIN set (docs/deploy.md, Your own domain). ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * The DNS `sst.aws.dns()` manages a name's records and certificate validation in: the zone named
 * `domain`. The lookup is an output from the start, so a refusal fails the deploy with its own
 * message, never as an unhandled rejection before SST reads the zone.
 */
export function zoneDns(domain: string) {
  return sst.aws.dns({ zone: $output(hostedZoneId(domain)) });
}
