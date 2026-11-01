# Deploying Plinthos

From a fresh clone to a working deployment in your own AWS account, and back to nothing. Each deployment has one owner and one stage, `production`, in one region you choose (`[PLAT-1]`). Everything owner-specific is configuration you set below, never a file in the repository (`[PLAT-2]`). `tests/infra/configuration.test.ts` fails when the stack reads a secret or a configuration value this guide does not name (`[PLAT-3]`).

What it deploys today is the walking skeleton's first slice: the admin's Next.js shell, which answers `/health/live` and nothing else, an alert topic that e-mails you, and a monthly cost budget. At rest it costs nothing (`docs/projects/6.md`, §4).

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

```sh
export PLINTHOS_AWS_REGION=eu-central-1
export PLINTHOS_BUDGET_LIMIT_USD=10
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

## 5. Build, then deploy

The build and the deploy are separate steps. `npm run build` builds the admin with OpenNext into `.open-next/`, without touching AWS; `sst deploy` deploys that build as it is and never builds (`infra/admin.ts`). This is how the deploy lane keeps its build away from any credential (`[PLAT-4]`).

```sh
npm run build
npx sst deploy --stage production
```

The first deploy takes a while: CloudFront distributions are slow to create. At the end it prints `adminUrl`, the admin's address, which it also writes to `.sst/outputs.json`.

## 6. Confirm the alert e-mail

AWS sends a subscription confirmation to `AlertEmail` during the first deploy. **Open it and confirm**: until you do, no budget alert or alarm reaches you. `docs/observability.md` records it as a hand-created step.

## 7. Check it

```sh
curl -s -o /dev/null -w "%{http_code}\n" "$(jq -r .adminUrl .sst/outputs.json)/health/live"
```

It prints `200`. `/health/live` never touches a database, so checking it costs nothing (`[PLAT-14]`).

## The deploy lane

**For now, deploy from your machine (step 5): it is the supported path.** Kanon's deploy lane is wired up, but it can't finish a deploy yet (see the known gap below). Once it can, releases deploy themselves through it (`.github/workflows/deploy.yml`, `docs/qa/adoption.md`'s `## Deploy`). Its build hook runs `npm run build` with no credential; its deploy hook assumes your deploy role through GitHub's OIDC token and runs `sst deploy --stage production`; its smoke hook fails the deploy unless `/health/live` answers 200 (`[PLAT-4]`).

It needs, in your fork:

- **The `production` GitHub environment**, with you as its required reviewer and deployments limited to release tags (`v*`).
- **A deploy role** in your account that trusts GitHub's OIDC provider for your repository's `production` environment subject, and nothing else. Read your repository's subject format first: `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`. A repository created after 2026-07-15 uses the immutable form, `repo:<owner>@<owner-id>/<repo>@<repo-id>:environment:production`.
- **These values in the hook's environment:**

  | Variable | What it is |
  |---|---|
  | `AWS_DEPLOY_ROLE_ARN` | The deploy role's ARN. The trust probe runs outside the environment, so it must be readable there too: a repository variable, not only an environment variable. |
  | `PLINTHOS_AWS_REGION` | As in step 3. |
  | `PLINTHOS_BUDGET_LIMIT_USD` | As in step 3, if you set it. |

- **The SST secrets** from step 4, which live in your account and need nothing in GitHub.

**Known gap: every release's deploy run stops at `probe-unconfigured`, and that is expected.** Kanon's trust probe at the pinned release (v0.42.0) runs with no environment, no variable and no secret, and the hooks are composite actions, which GitHub doesn't give the `vars` context. So the probe can't find the deploy role, answers `unconfigured`, and the lane stops before it builds or deploys anything ([yedeya-labs/kanon#1555](https://github.com/yedeya-labs/kanon/issues/1555)). Nothing is wrong with your deployment when that happens. Deploy from your machine (step 5) until Kanon passes the hooks their values; then this lane needs no change here.

## Tear it down

`sst remove` deletes what the stack created, except what holds data: the app is configured to retain its buckets and tables on removal (`sst.config.ts`, `removal: 'retain'`).

```sh
npx sst remove --stage production
```

Then delete what was retained, and the secrets:

1. List what is left, by the tags SST puts on every resource: `aws resourcegroupstaggingapi get-resources --region "$PLINTHOS_AWS_REGION" --tag-filters Key=sst:app,Values=plinthos Key=sst:stage,Values=production --query "ResourceTagMappingList[].ResourceARN"`.
2. Empty and delete each bucket it lists (`aws s3 rb s3://<bucket> --force`), delete each table (`aws dynamodb delete-table --table-name <table>`), and each log group whose name holds `plinthos-production` (`aws logs delete-log-group --log-group-name <name>`).
3. Remove each secret:

   ```sh
   npx sst secret remove AdminUsername --stage production
   npx sst secret remove AdminPasswordHash --stage production
   npx sst secret remove SessionSecret --stage production
   npx sst secret remove AlertEmail --stage production
   ```

4. SST keeps its own state and asset buckets for every app in the account and region, named `sst-state-…` and `sst-asset-…`. Delete them only if no other SST app uses that account and region.
5. If you made them for this deployment alone, delete the deploy role and the OIDC provider, then the account.
