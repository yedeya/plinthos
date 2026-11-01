# Deploying Plinthos

From a fresh clone to a working deployment in your own AWS account, and back to nothing. Each deployment has one owner and one stage, `production`, in one region you choose (`[PLAT-1]`). Everything owner-specific is configuration you set below, never a file in the repository (`[PLAT-2]`). `tests/infra/configuration.test.ts` fails when the stack reads a secret or a configuration value this guide does not name (`[PLAT-3]`).

What it deploys today is the walking skeleton's first slices: the admin's Next.js shell, which answers `/health/live` and nothing else, an alert topic that e-mails you, a monthly cost budget, and the database: Aurora Serverless v2 PostgreSQL, which pauses when idle and is reached only through the RDS Data API, in a VPC with nothing that routes in or out. At rest it costs about $0.65 a month, the database's storage, the secret that holds its master credential, and its not-paused alarm (`docs/projects/6.md`, §4).

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

```sh
export PLINTHOS_AWS_REGION=eu-central-1
export PLINTHOS_BUDGET_LIMIT_USD=10
export PLINTHOS_AURORA_MAX_ACU=1
```

`eu-central-1` is the reference deployment's region: use your own.

## 4. SST secrets

Each value is stored encrypted in your account, never in the repository. A deploy with any of them unset fails and prints the command for each missing one. Start each line with a space if your shell keeps lines that start with one out of its history.

| Secret | What it is |
|---|---|
| `AdminUsername` | The admin's sign-in name. |
| `AdminPasswordHash` | The scrypt hash of the admin's password, never the password itself. |
| `SessionSecret` | The key that signs session cookies: at least 32 random bytes. |
| `AlertEmail` | The address the alert topic e-mails: the budget alerts now, and every alarm after them. |

```sh
npx sst secret set AdminUsername <your-username> --stage production
npx sst secret set AdminPasswordHash '<the-hash>' --stage production
npx sst secret set SessionSecret "$(openssl rand -base64 48)" --stage production
npx sst secret set AlertEmail <you@example.com> --stage production
```

**The password hash.** The sign-in (#16) defines its format and adds the command that prints it from a password you type. Nothing reads the secret before then, so until #16 is deployed, set any placeholder and replace it with that command's output before you first sign in. Quote the hash: it contains characters the shell would expand.

To change a value later, run the same line again and deploy. Changing `SessionSecret` or `AdminPasswordHash` ends every session.

## 5. Build, deploy, then migrate

The build and the deploy are separate steps. `npm run build` builds the admin with OpenNext into `.open-next/`, without touching AWS; `sst deploy` deploys that build as it is and never builds (`infra/admin.ts`). This is how the deploy lane keeps its build away from any credential (`[PLAT-4]`). Then the migration step applies every database migration the deployment doesn't have yet, through the RDS Data API (`[PLAT-12]`). Run all three, in this order, on every deploy:

```sh
npm run build
npx sst deploy --stage production
npx sst shell --stage production -- npm run db:migrate
```

The first deploy takes a while: CloudFront distributions and the Aurora cluster are slow to create. At the end it prints `adminUrl`, the admin's address, which it also writes to `.sst/outputs.json`.

**The migration step** runs `scripts/migrate.ts` on your machine with your AWS credentials. `sst shell` hands it the deployed database's ARNs without printing them (an ARN holds your account ID). It reaches the database through the Data API, so it needs no network path into the VPC, and it waits out the cluster's resume when the cluster was paused (`[PLAT-10]`). It prints one line, such as `applied 2 migration(s), 2 in all`. Running it again applies none, so it is safe to repeat; a migration that fails applies nothing, and the next run tries again. Each run keeps the cluster awake for about six minutes, which costs about a cent.

## 6. Confirm the alert e-mail

AWS sends a subscription confirmation to `AlertEmail` during the first deploy. **Open it and confirm**: until you do, no budget alert or alarm reaches you. `docs/observability.md` records it as a hand-created step.

## 7. Check it

```sh
curl -s -o /dev/null -w "%{http_code}\n" "$(jq -r .adminUrl .sst/outputs.json)/health/live"
```

It prints `200`. `/health/live` never touches a database, so checking it costs nothing (`[PLAT-14]`).

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

- **The SST secrets** from step 4, which live in your account and need nothing in GitHub.

**Known gap: every release's deploy run stops at `probe-unconfigured`, and that is expected.** Kanon's trust probe at the pinned release (v0.42.0) runs with no environment, no variable and no secret, and the hooks are composite actions, which GitHub doesn't give the `vars` context. So the probe can't find the deploy role, answers `unconfigured`, and the lane stops before it builds or deploys anything ([yedeya-labs/kanon#1555](https://github.com/yedeya-labs/kanon/issues/1555)). Nothing is wrong with your deployment when that happens. Deploy from your machine (step 5) until Kanon passes the hooks their values; then this lane needs no change here.

## Tear it down

`sst remove` deletes what the stack created, except what holds data: the app is configured to retain its buckets, its tables and its database on removal (`sst.config.ts`, `removal: 'retain'`). For the database, SST keeps the Aurora cluster, its parameter groups and its subnet group, and the VPC with its subnets and default security group. It deletes the cluster's instance, so the retained cluster costs only its storage, and the secret that held its master password.

```sh
npx sst remove --stage production
```

Then delete what was retained, and the secrets:

1. List what is left, by the tags SST puts on every resource: `aws resourcegroupstaggingapi get-resources --region "$PLINTHOS_AWS_REGION" --tag-filters Key=sst:app,Values=plinthos Key=sst:stage,Values=production --query "ResourceTagMappingList[].ResourceARN"`.
2. Empty and delete each bucket it lists (`aws s3 rb s3://<bucket> --force`), delete each table (`aws dynamodb delete-table --table-name <table>`), and each log group whose name holds `plinthos-production` (`aws logs delete-log-group --log-group-name <name>`).
3. Delete the database, which deletes its data: first the cluster (`aws rds delete-db-cluster --db-cluster-identifier <cluster> --skip-final-snapshot`, or `--final-db-snapshot-identifier <name>` to keep a snapshot, which is billed), then, once it is gone, its subnet group (`aws rds delete-db-subnet-group --db-subnet-group-name <name>`), its cluster parameter group (`aws rds delete-db-cluster-parameter-group --db-cluster-parameter-group-name <name>`) and its instance parameter group (`aws rds delete-db-parameter-group --db-parameter-group-name <name>`). Then delete the VPC, which deletes its subnets and its default security group with it: delete each subnet (`aws ec2 delete-subnet --subnet-id <subnet>`), then the VPC (`aws ec2 delete-vpc --vpc-id <vpc>`). The listing in step 1 shows each of them.
4. Remove each secret:

   ```sh
   npx sst secret remove AdminUsername --stage production
   npx sst secret remove AdminPasswordHash --stage production
   npx sst secret remove SessionSecret --stage production
   npx sst secret remove AlertEmail --stage production
   ```

5. SST keeps its own state and asset buckets for every app in the account and region, named `sst-state-…` and `sst-asset-…`. Delete them only if no other SST app uses that account and region.
6. If you made them for this deployment alone, delete the deploy role and the OIDC provider, then the account.
