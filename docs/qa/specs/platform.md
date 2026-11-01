# Platform

The deployable shape of Plinthos: the SST v4 app, its one stage, the database and how it is reached, and the guards that keep the stack under the cost target in `AGENTS.md` §3. Seeded by the walking-skeleton project (#6). Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `PLAT`

## The app and its one stage

- `[PLAT-1]` `[seed]` `sst.config.ts` deploys only the stage `production`, and only to the one region the deployment's configuration names (`eu-central-1` is only the reference deployment's value); a deploy of any other stage name, or with no region configured, is refused before any resource is created.
- `[PLAT-2]` `[seed]` Every owner-specific value (the admin username and password hash, the session secret, the alert e-mail address, and a domain if one is used) is read from an SST secret or from the deployment's configuration, and a deploy with a required one unset fails and names it.
- `[PLAT-3]` `[seed]` `docs/deploy.md` names every SST secret and every configuration value the stack reads, with how to set it, and a test fails when the stack reads one the guide does not name.
- `[PLAT-4]` `[seed]` Production is deployed by Kanon's deploy lane: the build hook builds the OpenNext output without a cloud credential, the deploy hook deploys the stage `production`, and the smoke hook fails the deploy unless `/health/live` answers 200 (`K-SHIP-12`).

## Cost guards

- `[PLAT-5]` `[seed]` The stack creates no NAT gateway, no Elastic IP or other public IPv4 address, no VPC interface endpoint and no customer-managed KMS key, and attaches no Lambda function to a VPC.
- `[PLAT-6]` `[seed]` An AWS Budgets monthly cost budget on the account notifies the alert topic when actual spend passes 80% and when forecast spend passes 100% of the configured limit, which defaults to $10.
- `[PLAT-7]` `[seed]` The stack defines no recurring schedule (a cron, a warmer or a probe) that reaches the database.

## The database

- `[PLAT-8]` `[seed]` The database is an Aurora Serverless v2 PostgreSQL cluster with a minimum capacity of 0 ACU, a maximum the configuration sets, the RDS Data API enabled and deletion protection on, and it is not publicly accessible.
- `[PLAT-9]` `[seed]` Deployed code reaches the database only through the RDS Data API; the TCP driver is used only by tests, against the local PostgreSQL the project-setup hook starts.
- `[PLAT-10]` `[seed]` When the Data API reports that the cluster is resuming, the database module retries with backoff for up to 30 seconds before it fails the request, and logs the wait.
- `[PLAT-11]` `[seed]` Every schema change ships with the Drizzle migration generated from it, and the schema check CI runs fails when the schema and the committed migrations disagree.
- `[PLAT-12]` `[seed]` The deploy applies every pending migration through the Data API before the smoke check runs, and running it a second time applies none.
- `[PLAT-13]` `[seed]` Every table's primary key is a UUID that the application generates, never a database sequence.

## Liveness

- `[PLAT-14]` `[seed]` `/health/live` answers 200 without importing the database module, and still answers 200 when the database cannot be reached.
