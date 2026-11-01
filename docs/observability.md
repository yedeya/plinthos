# Observability

The one home for what each of Plinthos's signals means (`AGENTS.md` §2, `K-OBS-2`). `sst.config.ts` and `infra/` say what notifies; this document says what each notification means and what to do about it. Change both in the same pull request: `tests/infra/observability.test.ts` fails when a budget notification or an alarm the stack defines has no paged row here, when a paged row has no notification behind it, and when a `businessEvent` the code emits is in neither or both of the paged and not-paged tables (`[OPS-3]`).

Every paged signal goes to one SNS topic, `Alerts` (`infra/alerts.ts`), which e-mails the address in the `AlertEmail` secret (`[OPS-4]`). Whether a signal pages is decided by Kanon's admission rule, `K-OBS-4`; each decision not to page is a row of the not-paged table, with what would change it (`K-OBS-3`).

## Paged signals

These protect the cost target, under $10 a month (`AGENTS.md` §3). The limit is the deployment's `PLINTHOS_BUDGET_LIMIT_USD`, $10 unless it sets another (`docs/deploy.md`). AWS Budgets charges nothing for the budget and SNS nothing for these e-mails, so neither row adds to the bill. The not-paused alarm is a CloudWatch alarm, about $0.10 a month, which the Owner approved (`docs/projects/6.md`, decisions 4 and 5).

<!-- paging-clauses:table -->

| Signal | What it means | Threshold | What a person does |
|---|---|---|---|
| `budget.actual.80` | This month's actual spend on the account has passed 80% of the budget limit (`[PLAT-6]`). | Actual cost above 80% of the limit, as AWS Budgets measures it, a few times a day. | Open Cost Explorer for the month, grouped by service, and find what grew. The usual cause is an Aurora cluster that never pauses: find what keeps it awake. |
| `budget.forecast.100` | AWS forecasts that this month's spend will pass the budget limit (`[PLAT-6]`). | Forecast cost above 100% of the limit. | The same as above, before the money is spent: find the service whose daily cost grew, and stop what drives it. |
| `aurora.not_paused` | The Aurora cluster has stayed awake for 12 hours without pausing once (`[OPS-7]`, `infra/database.ts`). Awake all month at 0.5 ACU it would cost about $51, five times the budget. A recovery e-mail follows when it pauses again. | `ServerlessDatabaseCapacity`'s minimum above 0 in each of 12 consecutive one-hour periods; an hour with no data does not count. The 12 hours are not measured yet: #24's figures could move them. | Find what keeps calling the database. Something reaching it at least every five minutes keeps it awake: a schedule, a client retrying, or an anonymous path that touches the database (`[PLAT-7]`, `[AUTH-6]`). The cluster's CloudWatch metrics and the admin's logs show when the calls come. |

<!-- /paging-clauses:table -->

## Not-paged signals

<!-- not-paged-table -->

| Signal | Why it does not page | What would change the answer |
|---|---|---|
| `health.live` | There is no uptime probe. A Route 53 health check (about $0.50 a month) or a canary (about $10 at a 5-minute cadence) buys little for a one-owner admin, and the deploy's smoke check probes `/health/live` on every release (`[PLAT-4]`), without waking the database (`[PLAT-14]`). | Sharing the catalogue link with buyers, whose visits nobody else would see fail. |
| `admin.request.failed` | The admin's server code failed a request (`src/server/request-failure.ts`, `[OPS-5]`). Every admin request is started by the one owner, who sees the failure on the page, with the request id that the error line in the server function's log group names, so nobody needs paging (brief #6, §5 and decision 5). Paging it would cost about $0.40 a month, a metric filter's custom metric and its alarm. | A server-side background path, such as a scheduled price refresh, whose failures no one would see on a page. |
| `deploy.failed` | A failed deploy is not a cloud alarm: the deploy lane files, and keeps, one issue per environment for its failures (`K-SHIP-8`, `K-OBS-6`). | A deploy that runs outside the deploy lane, which would file no issue. |

<!-- /not-paged-table -->

## Hand-created resources

What exists outside `sst.config.ts`, created by hand, and how far each has been checked (`K-OBS-8`). "Configuration" means its settings were read back; "delivery" means a real notification was seen to arrive.

<!-- hand-created:table -->

| Resource | State | Verified |
|---|---|---|
| The AWS member account that holds only this deployment | created 2026-11-01 (#12) | configuration |
| The GitHub OIDC provider and the deploy role, trusting only the `production` environment's subject | created 2026-11-01 (#12) | configuration |
| The SST secret values (`docs/deploy.md`, step 4) | not yet created (#23) | no |
| The `Alerts` topic's e-mail subscription, confirmed from the first message | not yet created (#23) | no |

<!-- /hand-created:table -->
