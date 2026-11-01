/**
 * Reads a resource `infra/` links to the server function, through SST's own reader, which
 * decrypts the links SST bundles with the function. Answers undefined where nothing is linked:
 * in tests, in the build, and in `scripts/` run outside `sst shell`.
 */
import { Resource } from 'sst/resource';

/** A linked resource's field, such as a secret's `value` or a table's `name`, or undefined. */
export function linkedValue(name: string, field = 'value'): string | undefined {
  try {
    const resource = (Resource as unknown as Record<string, Record<string, unknown> | undefined>)[name];
    const value = resource?.[field];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}
