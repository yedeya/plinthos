# Plinthos: instructions for agents

Plinthos (πλίνθος, "brick") is a self-hosted catalogue for one LEGO collection. Anyone can deploy their own copy. The owner enters sets from a phone, imports the loose parts, and shares a public catalogue that visitors can only read. Selling the collection as a lot is an optional mode of that catalogue, not its premise. The product intent is in [`HANDOVER.md`](HANDOVER.md). Its technical section (§7) is superseded by the stack below.

The pillars below were adopted from classbyte2 (`AGENTS.md`, `docs/architecture-proposal.md`, `docs/observability.md`, `docs/security-review.md`) and scaled to a one-person project. Each pillar is a rule. A change that breaks one needs the owner's agreement first.

## The constraints, and what follows from them

| Constraint | Consequence |
|---|---|
| One developer | One language (TypeScript), one repository, managed services everywhere, mainstream tools |
| Low running cost | Nothing always-on. Serverless compute, and Aurora Serverless v2 with a minimum of 0 ACU. Target: **under $10 a month** |
| A public repository | No real data, secrets, account IDs or catalogue tokens in the repository |
| Visitors (buyers, in selling mode) arrive on phones from shared links | Public pages are static and fast, and never wait for the database |
| Anyone can deploy their own copy | One owner per deployment, no sign-up and no tenants. Nothing owner-specific in the code: names, the admin account, API keys, currency and catalogue texts come from the deployment's configuration and SST secrets. Setup is documented well enough to follow without the author |
| Selling is optional | Selling features (asking prices, buyer-facing values, split views with subtotals, the parts download) sit behind a selling mode that is off by default. Values stay private unless the owner shows them |

**Stack:** TypeScript, deployed with SST v4 to AWS in its own member account, in a region each deployment configures (`eu-central-1` for the reference deployment; the cost figures below are Frankfurt prices). Next.js (via OpenNext on Lambda) runs the admin app, with Drizzle and Aurora Serverless v2 PostgreSQL through the RDS Data API. Photos and the public catalogue live in S3 and are served by CloudFront. This is the same family as classbyte2 and kolophon, so reuse their patterns before inventing new ones.

## 1. Security is designed in, not reviewed in

Two open-source catalogues were evaluated and rejected for security reasons on 2026-10-31. Each of their failures is a requirement here, enforced by a test:

- **Public and private are separated by construction.** The public catalogue is a snapshot that a single publish step generates, containing only public data. Public pages never query the database. Totals, counts, search indexes and autocomplete are computed **from the snapshot**, so a hidden item can't leak through an aggregate. A test asserts that no private field appears anywhere in a generated snapshot. Private fields include `storage_location`, purchase prices and internal notes. Values and asking prices are private too unless the owner shows them (selling mode, or the show-values setting), and the test covers both settings.
- **Photos are re-encoded on upload, originals included.** Never keep or serve the uploaded bytes as they arrived. The phone may upload straight to S3 through a presigned URL, but only into a private **quarantine** prefix that nothing serves, with a short lifecycle expiry; a re-encode step writes every stored size and deletes the quarantined object. Re-encoding strips EXIF, GPS and the device model. A test uploads a photo with GPS data and asserts that every stored size has none and that the quarantined object is gone.
- **Public URLs can't be guessed or enumerated.** The catalogue token has at least 128 bits of entropy and can be rotated. Rotating it removes the old snapshot. Image keys are random. Public pages send `noindex`.
- **There is no first-visitor setup page.** The admin account is created from deployment configuration, never by whoever reaches a fresh install first.
- **Authorization is checked on every route, and tested on every route.** A test lists every admin route and asserts that it refuses an anonymous request. This exists because Blocks skipped role checks on every route with a URL parameter, and the bug went unnoticed.
- **Login is rate-limited.** Sessions can be revoked on the server: logout and password changes really end them.
- **Secrets stay in SST secrets, never in a file.** This includes the BrickLink OAuth keys, the Rebrickable key and the session secret. The repository is public: before every commit, check that the diff contains no IDs, tokens, e-mail addresses or real inventory data. Tests use made-up fixtures.
- **Every external API gets rate limiting, backoff and a timeout.** That covers Rebrickable, BrickLink and Brickset.
- **Release gate:** before the catalogue link is first shared, a security review is written in `docs/security-review.md` with findings `F-n` graded by likelihood × impact. The gate is "no open Critical or High findings". Each later release that touches auth, the publish step, uploads or infrastructure adds a dated pass.

## 2. Observability is part of feature planning

**Principle:** operational problems are alarms that notify, not dashboards you have to remember to check.

- When a feature adds a failure mode or an operational surface, decide whether it needs a signal. Examples: a scheduled job, an external integration, the publish step, the offline-sync path. **Surface that decision**, with the reason to add the signal *or* skip it. Deciding not to alert is also a decision, and it is recorded.
- Logs are structured JSON (pino), one line per event. Named `businessEvent` fields mark the events that matter, such as `price.refresh.failed`, `catalogue.published` and `sync.conflict`.
- Alarms are CloudWatch alarms defined in `sst.config.ts`, delivered by SNS to the owner. **`docs/observability.md` is the source of truth for what each signal means**, and `sst.config.ts` is the source of truth for what notifies. Update both in the same change.
- Every alarm costs about $0.10 a month, so a new alarm also falls under the cost rule below.

## 3. Cloud cost is discussed before it is incurred

**Any change that raises AWS spend needs the owner's agreement first.** This covers new resources, added capacity, a NAT, an Elastic IP, KMS keys and new alarms. Estimate the monthly change, say what drives it, and get a yes *before* implementing.

**Any recurring schedule that touches the database comes with a cost estimate.** Aurora pauses only after 300 seconds without a connection, so every tick keeps the cluster awake for at least *(duration + 5 minutes)*. At $0.14 per ACU-hour in Frankfurt (checked 2026-10-31), anything that runs more often than hourly keeps it awake almost permanently. This covers crons, warmers, uptime probes and scheduled GitHub Actions that reach the app. State how often it runs, whether it touches Aurora, and the monthly cost.

- **Liveness probes never touch the database.** Probe `/health/live` often and the database rarely.
- **No NAT gateway.** It costs about $41.60 a month, more than the rest of the stack. The BrickLink price refresh needs a registered fixed IP:
  1. First, try registering `0.0.0.0` with BrickLink.
  2. If that fails, use a t4g.nano with an Elastic IP, started only for the refresh, at about $4.40 a month.
- **The Data API instead of persistent connections**, so that Aurora can actually pause. In classbyte2 it never did.
- An AWS Budgets alert on the member account notifies the owner well before the target is exceeded.

## 4. A typed service core

Every domain operation is a plain typed function with zod-validated input, for example `registerSet`, `importPartsFile`, `startPriceRefresh` and `publishCatalogue`. The admin UI, the offline-sync endpoint, the background job and any scheduled job all call the same functions, so authorization, validation and logging happen in one place. Any future tool, an MCP tool included, reuses them.

## 5. Every issue belongs to a milestone

No issue is filed without a milestone.
- **Buckets** have no due date and never complete. An agent may route an issue to a bucket:
  - **Product Backlog**: product work, bugs, follow-ups.
  - **Development Automation**: CI, tooling and pipeline work.
- **Roadmap milestones** have a due date. Only the owner places work on them; an agent may suggest one.

Milestone pull requests are never set, because they corrupt the issue counts. File an issue with its labels and milestone in one `gh issue create` call.

## 6. Concurrent sessions get a worktree, never the main checkout

One issue gets one worktree and one local database. Two sessions never share a checkout, because migrations are not additive across branches and one session's migration silently breaks the other's tests. Ports are assigned per worktree. Until a worktree script exists (classbyte2's `scripts/wt.sh` is the model), create worktrees under `.claude/worktrees/<name>` and give each its own database and ports by hand.

## Workflow

This repository adopts the **Kanon** workflow. Its rulebook governs issues, briefs (`docs/projects/`), pull requests, review and merging. Where this file and Kanon overlap, Kanon's fixed rules win, and this file holds only the project's own choices.
