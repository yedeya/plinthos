# Platform

The deployable shape of Plinthos: the SST v4 app, its one stage, the database and how it is reached, and the guards that keep the stack under the cost target in `AGENTS.md` §3. Seeded by the walking-skeleton project (#6). Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `PLAT`

## The app and its one stage

- `[PLAT-1]` `[seed]` `sst.config.ts` deploys only the stage `production`, and only to the one region the deployment's configuration names (`eu-central-1` is only the reference deployment's value), except the ACM certificates CloudFront requires in `us-east-1`, which exist only while a domain is set (`[PLAT-18]`); a deploy of any other stage name, or with no region configured, is refused before any resource is created.
- `[PLAT-2]` `[seed]` Every owner-specific value (the admin username and password hash, the session secret, the alert e-mail address, and a domain if one is used) is read from an SST secret or from the deployment's configuration, and a deploy with a required one unset fails and names it.
- `[PLAT-3]` `[seed]` `docs/deploy.md` names every SST secret and every configuration value the stack reads, with how to set it, and a test fails when the stack reads one the guide does not name.
- `[PLAT-4]` `[seed]` Production is deployed by Kanon's deploy lane: the build hook builds the OpenNext output without a cloud credential, the deploy hook deploys the stage `production`, and the smoke hook fails the deploy unless `/health/live` answers 200 (`K-SHIP-12`).

## Cost guards

- `[PLAT-5]` `[seed]` The stack creates no NAT gateway, no Elastic IP or other public IPv4 address, no VPC interface endpoint and no customer-managed KMS key, and attaches no Lambda function to a VPC.
- `[PLAT-6]` `[seed]` An AWS Budgets monthly cost budget on the account notifies the alert topic when actual spend passes 80% and when forecast spend passes 100% of the configured limit, which defaults to $10.
- `[PLAT-7]` `[seed]` The stack defines no recurring schedule (a cron, a warmer or a probe) that reaches the database.

## The database

- `[PLAT-8]` `[seed]` The database is an Aurora Serverless v2 PostgreSQL cluster with a minimum capacity of 0 ACU, a maximum the configuration sets, the RDS Data API enabled and deletion protection on, and it is not publicly accessible.
- `[PLAT-15]` `[seed]` The database keeps point-in-time recovery for 35 days, Aurora's maximum, so any second of the last 35 days can be restored; deletion protection stays on (`[PLAT-8]`). Seeded by the Owner's decision of 2026-11-02, before real data is entered.
- `[PLAT-9]` `[seed]` Deployed code reaches the database only through the RDS Data API; the TCP driver is used only by tests, against the local PostgreSQL the project-setup hook starts.
- `[PLAT-10]` `[seed]` When the Data API reports that the cluster is resuming, the database module retries with backoff for up to 30 seconds before it fails the request, and logs the wait.
- `[PLAT-16]` `[seed]` The admin's server function streams its responses (OpenNext's `aws-lambda-streaming` wrapper, so the function URL's invoke mode is `RESPONSE_STREAM`), and every page under `/admin` has a loading screen, `src/app/admin/loading.tsx`, which reaches the browser before the page's data, so a page that waits for the cluster to resume (`[PLAT-10]`) shows a spinner and a short line rather than a blank screen (#203). The loading screen holds no data: it imports nothing but the message file, reads no request, cookie, environment or storage, and calls no database, so it is the one segment file under `/admin` not built with `adminPage` (`[AUTH-4]`).
- `[PLAT-11]` `[seed]` Every schema change ships with the Drizzle migration generated from it, and the schema check CI runs fails when the schema and the committed migrations disagree.
- `[PLAT-12]` `[seed]` The deploy applies every pending migration through the Data API before the smoke check runs, and running it a second time applies none.
- `[PLAT-13]` `[seed]` Every table's primary key is a UUID that the application generates, never a database sequence.

## Liveness

- `[PLAT-14]` `[seed]` `/health/live` answers 200 without importing the database module, and still answers 200 when the database cannot be reached.

## The deployment's own domain

Seeded by the own-domain project (#293). Examples use `example.com`: a deployment's real name lives only in its configuration, never in the repository.

- `[PLAT-17]` `[seed]` `PLINTHOS_DOMAIN` is optional. Unset or blank, the stack creates no certificate, no DNS record and no alias, and both distributions keep their `cloudfront.net` hosts with CloudFront's default certificate. Set, it is trimmed and lowercased, and refused before any resource is created, naming the setting, unless it is a hostname such as `plinthos.example.com`: at least two labels, each of 1 to 63 letters, digits or hyphens that neither starts nor ends with a hyphen, at most 243 characters in all so that `catalogue.` fits before it, with no scheme, port, path, wildcard or trailing dot, and not under `cloudfront.net` or `amazonaws.com`.
- `[PLAT-18]` `[seed]` With a domain set, the admin's distribution answers at the domain itself and the public distribution at `catalogue.` followed by it, each with its own ACM certificate in `us-east-1` for that one name, validated by DNS in the Route 53 hosted zone whose name is the domain, with A and AAAA alias records in that zone and a minimum protocol of `TLSv1.2_2021`. The stack looks the zone up by name and never creates, changes or deletes the zone itself, so `sst remove` leaves it and its name servers as they were; a deploy that finds no zone of that name fails and says so.
- `[PLAT-19]` `[seed]` With a domain set, the admin's `cloudfront.net` host answers every request with 403, `/health/live` included, and `adminUrl`, the address the smoke check probes (`[PLAT-4]`) and the photo bucket's CORS rule allows (`[PHOTO-10]`), is `https://` followed by the domain.
