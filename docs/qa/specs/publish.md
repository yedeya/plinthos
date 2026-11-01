# The public snapshot

How the public catalogue is separated from private data by construction: a static snapshot that one publish step generates, served from S3 by CloudFront, never from the database (`AGENTS.md` §1, `HANDOVER.md` §4.3 and §8). Seeded by the walking-skeleton project (#6). Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `PUB`

## Public and private, by construction

- `[PUB-1]` `[seed]` The public catalogue is served by a CloudFront distribution whose only origin is the private snapshot bucket, reached through origin access control; it has no dynamic origin, and the bucket blocks all public access.
- `[PUB-2]` `[seed]` Every response from the public distribution carries `X-Robots-Tag: noindex`, and a request for `/`, for `/c/` or for an unknown token is answered without a listing of the bucket.
- `[PUB-3]` `[seed]` Every column of the database schema is classified as public or private in one registry, a column with no classification fails the test, and values and asking prices are classified private unless the settings show them.
- `[PUB-4]` `[seed]` No private field's value appears anywhere in a generated snapshot: the test fills every private field with a canary value and scans every byte of every file the publish step writes, for every combination of `show_values`, `selling_mode` and `selling_value_display`.
- `[PUB-5]` `[seed]` The snapshot writer accepts only the public projection's type, and the publish step reads the database only through the one function that builds that projection.

## The publish step

- `[PUB-6]` `[seed]` `publishCatalogue` is a typed service function with zod-validated input that only an authenticated admin can call; it writes the placeholder snapshot under `/c/{token}/`, invalidates only that path in CloudFront, and logs the `businessEvent` `catalogue.published` or `catalogue.publish.failed`.
- `[PUB-7]` `[seed]` The catalogue token holds at least 128 bits from a cryptographically secure generator and is URL-safe.
