# Architecture and monthly cost

A one-page overview of the walking skeleton's architecture and what it costs to run. The plan and its decisions are in [`docs/projects/6.md`](projects/6.md), and the rules behind them are in [`AGENTS.md`](../AGENTS.md). Where this page and either of those disagree, they win. Deploying is covered in [`docs/deploy.md`](deploy.md), and what each alarm and log event means is in [`docs/observability.md`](observability.md).

Everything runs in one AWS account, in the region the deployment configures (`eu-central-1` for the reference deployment, whose prices are used below). It is deployed with SST as a single `production` stage. Nothing runs all the time: every part either costs nothing when idle or pauses.

## The parts

| Part | What it is | Why |
|---|---|---|
| **Admin app** | Next.js through OpenNext on Lambda, behind its own CloudFront distribution. Outside any VPC. | Serverless, so it costs nothing when idle. |
| **Database** | Aurora Serverless v2 PostgreSQL, 0 to 1 ACU, used only through the RDS Data API. Drizzle for the schema and migrations. | The Data API holds no open connections, so the cluster can actually pause. |
| **Login** | A username and a scrypt password hash stored as an SST secret. Sessions are stored in Aurora, as a hash of each session id. Rate limiting is in DynamoDB on-demand. | Bots and anonymous requests never wake Aurora. |
| **Public catalogue** | A static snapshot in a private S3 bucket, served by a second CloudFront distribution whose only origin is that bucket. It lives under a random token path of at least 128 bits and is sent with `noindex`. | Public pages can't reach the database or a private field, by construction. |
| **Offline entry** | An installable web app. The service worker caches only the empty shell. An IndexedDB queue replays into one sync endpoint, with each change keyed by a UUID. | Entering sets from a phone with no signal. |
| **Photos** | The phone uploads straight to a quarantine prefix in S3 through a presigned link, and anything left there expires after a day. The server re-encodes each photo with sharp to WebP with no metadata, then deletes the upload. The admin's server function runs on arm64 at 1536 MB for sharp. | GPS and EXIF are never stored. |
| **Operations** | pino JSON logs, one SNS alert topic that sends e-mail, a budget alert, and one alarm if Aurora hasn't paused in 12 hours. | Problems arrive as notifications, not dashboards to remember. |

Every part above is on `main` as of 2026-11-02, the photo path included (#92). The deploy rehearsal (#23) is what proves them in a real account: what CI's stand-ins can't show, such as S3's enforcement of the presigned upload, the quarantine's lifecycle rule and sharp loading on Lambda, is measured there.

## Monthly cost

| Item | Notes | Monthly |
|---|---|---:|
| Aurora credential secret | Read by the Data API | $0.40 |
| Aurora storage | Under 1 GB | ~$0.12 |
| "Not paused" alarm | The one paged CloudWatch alarm | $0.10 |
| Logs and SST buckets | CloudWatch Logs kept 30 days, the SST state and asset buckets | ~$0.10 |
| Photo bucket | Test photos, and deleted photos kept 30 days in its trash (`[PHOTO-9]`). The lifecycle and CORS rules are free | ~$0.02 |
| Aurora backups | 35 days of point-in-time recovery (`[PLAT-15]`), free up to the cluster's size | ~$0 |
| Everything else | Lambda, both CloudFront distributions, DynamoDB, Data API calls, SNS, Budgets, the VPC | ~$0 |
| **At rest** | | **~$0.77** |
| Aurora awake | About 10 hours of admin use at 0.5 to 1 ACU, plus about 60 deploy migrations | +$1.10 to $1.80 |
| **In normal use** | | **~$2 to $3** |

The AWS Budgets alert is set at $10 a month and notifies at 80% of actual spend and 100% of forecast spend.

### The main risk: Aurora never pausing

0.5 ACU × 730 hours × $0.14 comes to about $51 a month. Aurora pauses only after 5 minutes without a connection, so anything that reaches it more often than hourly keeps it awake. Three guards stand against it:

- no anonymous path calls the database (`[AUTH-6]`);
- the alarm pages after 12 hours awake (`[OPS-7]`);
- the budget pages on its forecast (`[PLAT-6]`).

## Deliberately left out

- A NAT gateway, about $41.60 a month, which is more than the rest of the stack.
- Public IPv4 addresses, about $3.65 each.
- WAF, $5 a month and up.
- A synthetic uptime canary, about $10 a month at a 5-minute cadence.
- A customer-managed KMS key ($1) and a Route 53 zone ($0.50).
- Any scheduled job that touches the database.

`[PLAT-5]` refuses the first two and the KMS key in code.

## How sure these figures are

Only the Aurora price, $0.14 per ACU-hour in Frankfurt, was checked (2026-10-31). The other prices are recalled, not re-checked. Issue #24 measures the real figure over 14 days after the deploy rehearsal (#23). Any change that raises spend needs the owner's agreement first (`AGENTS.md` §3), and this page should be updated in the same change.
