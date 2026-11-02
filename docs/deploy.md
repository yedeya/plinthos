# Deploying Plinthos

From a fresh clone to a working deployment in your own AWS account, and back to nothing. Each deployment has one owner and one stage, `production`, in one region you choose (`[PLAT-1]`). Everything owner-specific is configuration you set below, never a file in the repository (`[PLAT-2]`). `tests/infra/configuration.test.ts` fails when the stack reads a secret or a configuration value this guide does not name (`[PLAT-3]`).

What it deploys today is the walking skeleton's first slices: the admin's Next.js app, with `/health/live`, the sign-in and a placeholder signed-in page at `/admin`; an alert topic that e-mails you; a monthly cost budget; the database, Aurora Serverless v2 PostgreSQL, which pauses when idle and is reached only through the RDS Data API, in a VPC with nothing that routes in or out; the sign-in's rate limiter, a DynamoDB table billed per request; and the public catalogue's path, a private S3 bucket behind a CloudFront distribution of its own, with a Publish button on `/admin` that writes a placeholder snapshot into it; and the photo path, a private S3 bucket the phone uploads photos into, through a quarantine that nothing serves and that empties itself, which the admin re-encodes into stored sizes only you can see. At rest it costs about $0.67 a month, the database's storage, the secret that holds its master credential, its not-paused alarm, and about $0.02 for a gigabyte of photos; the rate limiter's table and the snapshot's few kilobytes cost nothing measurable (`docs/projects/6.md`, §4).

## 1. What you need

- **An AWS account that holds nothing but this deployment.** A member account of an AWS Organization is best: the budget measures the whole account, and the deploy role is broad.
- **Credentials for it on your machine** with administrator rights, as an AWS CLI profile, for the first deploy and for setting secrets. Export the profile in every shell you use below: `export AWS_PROFILE=<your-profile>`.
- **Node.js 24**, the version `.nvmrc` pins, with npm, and git.

## 2. Clone and install

```sh
git clone https://github.com/yedeya/plinthos.git
cd plinthos
npm ci
```

## 3. Configuration values

Set these in every shell you run `sst` in. Every `sst` command refuses to start without the required ones, or with any stage but `production`, before it touches AWS. SST prints only `Unexpected error occurred` for a refusal at that point: run the command again with `--print-logs`, and the error names the value that is missing or wrong.

| Variable | Required | What it is |
|---|---|---|
| `PLINTHOS_AWS_REGION` | yes | The AWS region the whole deployment lives in. Choose one close to you. |
| `PLINTHOS_BUDGET_LIMIT_USD` | no, default `10` | The monthly budget limit in US dollars. You are e-mailed at 80% of actual spend and at 100% of forecast spend. |
| `PLINTHOS_AURORA_MAX_ACU` | no, default `1` | Aurora's maximum capacity, from 1 to 256 ACUs in steps of 0.5. Each awake hour costs up to this many ACU-hours (about $0.14 each in Frankfurt). The minimum is always 0, so the database pauses after five idle minutes and costs nothing for compute while paused. |
| `PLINTHOS_SESSION_IDLE_DAYS` | no, default `7` | Days a sign-in lasts without a visit. After that, you sign in again. A whole number from 1 to 365. |
| `PLINTHOS_SESSION_ABSOLUTE_DAYS` | no, default `30` | Days a sign-in lasts at most, however often you use it. A whole number from 1 to 365, no shorter than the idle lifetime. |
| `PLINTHOS_LOGIN_ATTEMPTS_PER_ADDRESS` | no, default `10` | Sign-in attempts one address may make in 15 minutes. After that, that address is refused until the 15 minutes are over. A whole number, at least 1 and lower than the total. |
| `PLINTHOS_LOGIN_ATTEMPTS_TOTAL` | no, default `100` | Sign-in attempts every address together may make in 15 minutes. After that, every address is refused, yours included, until the 15 minutes are over. A whole number, at least 1. |
| `PLINTHOS_PHOTO_LONGEST_EDGE` | no, default `2048` | The longest edge, in pixels, your phone resizes a photo to before it uploads it. The stored full size is at most this; the thumbnail is 320. A whole number from 320 to 8192. |
| `PLINTHOS_PHOTO_MAX_BYTES` | no, default `4194304` | The largest photo upload, in bytes (4 MiB by default). S3 refuses a bigger upload, and the server refuses a bigger photo before it decodes it. A resized phone photo is usually well under 2 MiB. A whole number from 65536 to 20971520. |

```sh
export PLINTHOS_AWS_REGION=eu-central-1
export PLINTHOS_BUDGET_LIMIT_USD=10
export PLINTHOS_AURORA_MAX_ACU=1
export PLINTHOS_SESSION_IDLE_DAYS=7
export PLINTHOS_SESSION_ABSOLUTE_DAYS=30
export PLINTHOS_LOGIN_ATTEMPTS_PER_ADDRESS=10
export PLINTHOS_LOGIN_ATTEMPTS_TOTAL=100
export PLINTHOS_PHOTO_LONGEST_EDGE=2048
export PLINTHOS_PHOTO_MAX_BYTES=4194304
```

A lifetime change applies on the next deploy, to every session, the ones already started included.

A limit change applies on the next deploy too. An address's attempts stop counting toward the total once that address is refused, so one address alone can't use the total up. Many addresses together can: if someone else's attempts lock you out of the sign-in, raise `PLINTHOS_LOGIN_ATTEMPTS_TOTAL` and deploy again, or wait for the 15 minutes to end. A sign-in you already have keeps working either way.

`eu-central-1` is the reference deployment's region: use your own.

## 4. SST secrets

Each value is stored encrypted in your account, never in the repository. A deploy with any of them unset fails and prints the command for each missing one. Start each line with a space if your shell keeps lines that start with one out of its history.

| Secret | What it is |
|---|---|
| `AdminUsername` | The admin's sign-in name. This and the password hash are the one admin account: there is no sign-up or setup page. |
| `AdminPasswordHash` | The scrypt hash of the admin's password, never the password itself. The command below prints it. |
| `SessionSecret` | The key that signs session cookies: at least 32 random bytes. |
| `AlertEmail` | The address the alert topic e-mails: the budget alerts now, and every alarm after them. |

```sh
npx sst secret set AdminUsername <your-username> --stage production
npx sst secret set AdminPasswordHash "$(npm run --silent auth:hash-password)" --stage production
npx sst secret set SessionSecret "$(openssl rand -base64 48)" --stage production
npx sst secret set AlertEmail <you@example.com> --stage production
```

**The password hash.** `npm run --silent auth:hash-password` asks for the password twice without showing it, and prints only its scrypt hash, which the line above passes straight to `sst secret set`, so the password is never in your shell's history or on the screen. It reaches nothing: no AWS, no database. The password must be at least 12 characters. The hash looks like `scrypt:ln=17,r=8,p=1:<salt>:<key>`: its parameters are stored with it, and it holds no character a shell expands. Piped instead of typed, the command reads the password from the first line of its input.

To change a value later, run the same line again and deploy. Changing `AdminPasswordHash`, `AdminUsername` or `SessionSecret` ends every session at once, signed in elsewhere included: each session cookie is signed with a key derived from all three. That is also how you sign out a lost phone. The deploy's migration step (step 5) then deletes those sessions on the server, so they stay ended even if you later set a value back to what it was. `SessionSecret` must be at least 32 characters; the command above makes 64.

## 5. Build, deploy, then migrate

The build and the deploy are separate steps. `npm run build` builds the admin with OpenNext into `.open-next/`, without touching AWS; `sst deploy` deploys that build as it is and never builds (`infra/admin.ts`). This is how the deploy lane keeps its build away from any credential (`[PLAT-4]`). Then the migration step applies every database migration the deployment doesn't have yet, through the RDS Data API (`[PLAT-12]`). Run all three, in this order, on every deploy:

```sh
npm run build
npx sst deploy --stage production
npx sst shell --stage production -- npm run db:migrate
```

The first deploy takes a while: CloudFront distributions and the Aurora cluster are slow to create. At the end it prints `adminUrl`, the admin's address, and `catalogueHost`, the public catalogue's host, which it also writes to `.sst/outputs.json`. The host alone serves nothing: a catalogue's address also holds its token, which `/admin` shows after a publish.

**The migration step** runs `scripts/migrate.ts` on your machine with your AWS credentials. `sst shell` hands it the deployed database's ARNs without printing them (an ARN holds your account ID). It reaches the database through the Data API, so it needs no network path into the VPC, and it waits out the cluster's resume when the cluster was paused (`[PLAT-10]`). It logs one JSON line whose message reads, for example, `applied 2 migration(s), 2 in all`. Then it deletes every admin session signed with a key the deployed secrets no longer derive, which `sst shell` also hands it, and logs how many: none unless a step 4 secret changed (`[AUTH-10]`). Running it again applies none, so it is safe to repeat; a migration that fails applies nothing, and the next run tries again. Each run keeps the cluster awake for about six minutes, which costs about a cent.

## 6. Confirm the alert e-mail

AWS sends a subscription confirmation to `AlertEmail` during the first deploy. **Open it and confirm**: until you do, no budget alert or alarm reaches you. `docs/observability.md` records it as a hand-created step.

## 7. Check it

```sh
curl -s -o /dev/null -w "%{http_code}\n" "$(jq -r .adminUrl .sst/outputs.json)/health/live"
```

It prints `200`. `/health/live` never touches a database, so checking it costs nothing (`[PLAT-14]`).

Then open the `adminUrl` followed by `/login` in a browser, and sign in with `AdminUsername` and the password you hashed. After ten failed attempts from one address in 15 minutes, the sign-in refuses that address, and after a hundred from all addresses together it refuses every address, until the 15 minutes are over (`[AUTH-12]`; step 3 sets both limits): wait, then try again. A refused or failed sign-in never wakes the database.

Sign in through `adminUrl`, never through the server function's own Lambda URL. That URL is open, and a sign-in sent to it is refused with 403 (`[AUTH-14]`). This is a decision (#61), not something left over:

- **Why the URL has no IAM auth.** SST can put the URL behind IAM with CloudFront origin access control (`protection: "oac"`). But then every POST must carry the hash of its body in `x-amz-content-sha256`, and the sign-in is a plain HTML form, which can't send that header. The variant that signs at the edge, `"oac-with-edge-signing"`, adds a Lambda@Edge function in `us-east-1` with log groups in every edge region, and was turned down.
- **What closes the gap instead.** The admin's distribution adds a header, `x-plinthos-origin`, to every request, replacing any value the viewer sent. Its value is an HMAC of `SessionSecret`. The sign-in refuses a request without it before anything else. Without this, a caller of the URL could choose the address the rate limiter counts it under, and only the total limit would hold. It costs nothing and needs no secret of its own. Changing `SessionSecret` (step 4) changes the header too, and the deploy updates both.
- **Where the value can be seen.** It is in the distribution's CloudFront Function code and in SST's state, where anyone who can read the account's resources can see it. A viewer never can.

Then press **Publish** on `/admin`. The first publish makes the catalogue's token and shows the catalogue's address, `catalogueHost` followed by `/c/<token>/`; open it, and it says that nothing is published yet. A failed publish says so on the page, with a reference, and leaves the previous catalogue online (`[OPS-6]`). Check that the public distribution sends `noindex` and lists nothing (`[PUB-2]`):

```sh
curl -sI "$(jq -r .catalogueHost .sst/outputs.json)/" | grep -iE "^HTTP|x-robots-tag"
```

It prints a `403` status, not a listing, and `x-robots-tag: noindex, nofollow`. Keep the catalogue's address to yourself for now: sharing it waits for `docs/security-review.md` (`AGENTS.md` §1).

## 8. Install the admin on your phone

The admin is an installable web app with an offline queue (`[SYNC-5]`, `[SYNC-7]`). **Install it before you rely on the queue:** open the `adminUrl` in your phone's browser, sign in, and choose *Add to Home Screen* (Safari) or *Install app* (Chrome). Safari may delete a site's stored data after seven days without a visit unless the site is installed, and that data includes changes still waiting to sync.

- Sign in while you have a signal: there is no offline sign-in. After that, the installed admin opens without a network to its offline shell, which shows what is waiting on the phone.
- Changes made offline wait on the phone and sync when the network returns or when you open the admin, never on a timer, so the queue never wakes the database on its own. A queue that outlasts your session (7 days idle) stays on the phone and syncs after you sign in again.
- A change the server did not apply stays at the head of the queue, listed on `/admin` with *Retry* and *Discard*, and nothing queued after it syncs until you choose one.
- **Sign out deletes the queue and the cached shell from the phone**, after telling you how many changes are not yet synced. It needs a network, since the server must end the session too. If you lose your phone, change `SessionSecret` (step 4): that ends its session from anywhere, so nobody can use the admin on it. It can't reach the queue, though: whatever was still unsynced stays on that phone, whether you end the session or it has already expired.

**Photos.** *Add photos* on `/admin`, or on the offline shell, takes or picks photos. The phone resizes each one to `PLINTHOS_PHOTO_LONGEST_EDGE`, re-compresses it as JPEG and queues it with the rest; it syncs like any other change, offline included.

- When it syncs, the phone uploads the photo straight to the photo bucket, into a quarantine that nothing serves, and the admin then re-encodes it into a full size and a thumbnail, with no location, camera or other metadata, and deletes the upload (`AGENTS.md` §1). Anything left in the quarantine, by a crash, is deleted by the bucket within about a day.
- The photo stays on the phone, in the queue, until the server has stored it. If the upload expired before it synced, the phone uploads it again by itself.
- Stored photos are listed on `/admin` as thumbnails, through links that expire after 10 minutes; reload the page for fresh ones, and to see photos that have just synced. *Delete* removes a photo and its files.
- In this release a photo belongs to nothing and is never published.

The service worker and the queue live in the phone's browser and cost nothing on AWS.

## The deploy lane

**For now, deploy from your machine (step 5): it is the supported path.** Kanon's deploy lane is wired up, but it can't finish a deploy yet (see the known gap below). Once it can, releases deploy themselves through it (`.github/workflows/deploy.yml`, `docs/qa/adoption.md`'s `## Deploy`). Its build hook runs `npm run build` with no credential; its deploy hook assumes your deploy role through GitHub's OIDC token, runs `sst deploy --stage production`, then the same migration step as step 5; its smoke hook fails the deploy unless `/health/live` answers 200 (`[PLAT-4]`).

It needs, in your fork:

- **The `production` GitHub environment**, with you as its required reviewer and deployments limited to release tags (`v*`).
- **A deploy role** in your account that trusts GitHub's OIDC provider for your repository's `production` environment subject, and nothing else. Read your repository's subject format first: `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`. A repository created after 2026-07-15 uses the immutable form, `repo:<owner>@<owner-id>/<repo>@<repo-id>:environment:production`.
- **These values in the hook's environment:**

  | Variable | What it is |
  |---|---|
  | `AWS_DEPLOY_ROLE_ARN` | The deploy role's ARN. The trust probe runs outside the environment, so it must be readable there too: a repository variable, not only an environment variable. |
  | `PLINTHOS_AWS_REGION` | As in step 3. |
  | `PLINTHOS_BUDGET_LIMIT_USD` | As in step 3, if you set it. |
  | `PLINTHOS_AURORA_MAX_ACU` | As in step 3, if you set it. |
  | `PLINTHOS_SESSION_IDLE_DAYS` | As in step 3, if you set it. |
  | `PLINTHOS_SESSION_ABSOLUTE_DAYS` | As in step 3, if you set it. |
  | `PLINTHOS_LOGIN_ATTEMPTS_PER_ADDRESS` | As in step 3, if you set it. |
  | `PLINTHOS_LOGIN_ATTEMPTS_TOTAL` | As in step 3, if you set it. |
  | `PLINTHOS_PHOTO_LONGEST_EDGE` | As in step 3, if you set it. |
  | `PLINTHOS_PHOTO_MAX_BYTES` | As in step 3, if you set it. |

- **The SST secrets** from step 4, which live in your account and need nothing in GitHub.

**Known gap: every release's deploy run stops at `probe-unconfigured`, and that is expected.** Kanon's trust probe at the pinned release (v0.42.0) runs with no environment, no variable and no secret, and the hooks are composite actions, which GitHub doesn't give the `vars` context. So the probe can't find the deploy role, answers `unconfigured`, and the lane stops before it builds or deploys anything ([yedeya-labs/kanon#1555](https://github.com/yedeya-labs/kanon/issues/1555)). Nothing is wrong with your deployment when that happens. Deploy from your machine (step 5) until Kanon passes the hooks their values; then this lane needs no change here.

## Tear it down

`sst remove` deletes what the stack created, except what holds data: the app is configured to retain its buckets, its tables and its database on removal (`sst.config.ts`, `removal: 'retain'`). For the database, SST keeps the Aurora cluster, its parameter groups and its subnet group, and the VPC with its subnets and default security group. It deletes the cluster's instance, so the retained cluster costs only its storage, and the secret that held its master password. The cluster also has deletion protection on, which `sst remove` leaves on, so nothing deletes it until you switch that off in step 3 below.

```sh
npx sst remove --stage production
```

Then delete what was retained, and the secrets:

1. List what is left, by the tags SST puts on every resource: `aws resourcegroupstaggingapi get-resources --region "$PLINTHOS_AWS_REGION" --tag-filters Key=sst:app,Values=plinthos Key=sst:stage,Values=production --query "ResourceTagMappingList[].ResourceARN"`.
2. Empty and delete each bucket it lists (`aws s3 rb s3://<bucket> --force`), the snapshot bucket and the photo bucket included, which `sst remove` keeps without their policies (the photo bucket also without its CORS and lifecycle rules, so a quarantined upload no longer expires by itself: `--force` deletes everything in it), so nothing serves them, delete each table (`aws dynamodb delete-table --table-name <table>`), and each log group whose name holds `plinthos-production` (`aws logs delete-log-group --log-group-name <name>`).
3. Delete the database, which deletes its data. The cluster has deletion protection on, so switch it off first: `aws rds modify-db-cluster --db-cluster-identifier <cluster> --no-deletion-protection --apply-immediately`. Then delete the cluster (`aws rds delete-db-cluster --db-cluster-identifier <cluster> --skip-final-snapshot`, or `--final-db-snapshot-identifier <name>` to keep a snapshot, which is billed), then, once it is gone, its subnet group (`aws rds delete-db-subnet-group --db-subnet-group-name <name>`), its cluster parameter group (`aws rds delete-db-cluster-parameter-group --db-cluster-parameter-group-name <name>`) and its instance parameter group (`aws rds delete-db-parameter-group --db-parameter-group-name <name>`). Then delete the VPC, which deletes its subnets and its default security group with it: delete each subnet (`aws ec2 delete-subnet --subnet-id <subnet>`), then the VPC (`aws ec2 delete-vpc --vpc-id <vpc>`). The listing in step 1 shows each of them.
4. Remove each secret:

   ```sh
   npx sst secret remove AdminUsername --stage production
   npx sst secret remove AdminPasswordHash --stage production
   npx sst secret remove SessionSecret --stage production
   npx sst secret remove AlertEmail --stage production
   ```

5. SST keeps its own state and asset buckets for every app in the account and region, named `sst-state-…` and `sst-asset-…`. Delete them only if no other SST app uses that account and region.
6. If you made them for this deployment alone, delete the deploy role and the OIDC provider, then the account.
