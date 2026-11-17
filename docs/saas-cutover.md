# Cutover: single-team console → multi-company (SaaS) mode

This moves **ops.glenify.studio** from the single-team console to the multi-company product **in place**. Nothing is
copied: the existing servers, apps, history, alerts and users are already **workspace 1** (migration 015), on the
`internal` plan (never billed). Its admins are the platform's administrators.

The order matters. Everything that needs AWS or GitHub is connected **while the console is still single-team**, so
when the switch flips, workspace 1 already works. There is no gap where the console can't reach the servers.

Expected time: about 30 minutes, with roughly 1 minute when the console restarts. The apps on the servers are never
affected.

---

## 0. Before starting

- [ ] Everything merged and deployed (`./deploy.sh ops-console install`).
- [ ] A quiet window (outside office hours; deploys paused).
- [ ] SSH access to the server: `scripts/allow-my-ip.sh`.

Run the console's CLI on the server with its settings loaded:

```bash
# on the server (ssh ec2-user@<host>)
cli() { sudo bash -c 'set -a; . /run/app-secrets/ops-console.env; set +a; cd /opt/ops-console/api && exec node dist/cli.js "$@"' _ "$@"; }
cli cutover-check
```

`cutover-check` lists what is ready (✔) and what isn't (✘ / ·). Run it again after every step.

## 1. Back up the console database

```bash
pg_dump -h localhost -U postgres -w -Fc --no-owner opsconsole > /var/backups/app-db/opsconsole-before-cutover-$(date -u +%Y%m%dT%H%M%SZ).dump
```

## 2. Emails on existing accounts

Multi-company mode uses email for password resets and invitations. Existing users can still sign in with their
username. Each person adds an email under **Account** (once, with their password). The owner can also set one:

```bash
cli set-email <username> <email>      # they confirm it from the email they receive
```

## 3. Publish the template and the server bundle (once)

From a laptop with AWS credentials, in the repo:

```bash
./infra/saas/publish-template.sh --dry-run    # shows what it would create
./infra/saas/publish-template.sh              # prints CONNECT_TEMPLATE_URL, SERVER_BUNDLE_URL, SERVER_BUNDLE_SHA256
```

## 4. Let the console assume access roles

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws iam put-role-policy --role-name lendify-instance-role --policy-name ops-console-saas \
  --policy-document "$(sed "s/\${ACCOUNT_ID}/$ACCOUNT/g" infra/iam/instance-ops-console-saas.json)"
```

## 5. Create workspace 1's access role in the platform's own account

On the server:

```bash
cli cutover-prepare af-south-1
```

It prints the workspace's **External ID**, the **console identity** and a ready-made `aws cloudformation create-stack`
command (with `InstallDocuments=no`, because the documents already exist). Create the stack from a laptop with
`--template-url <CONNECT_TEMPLATE_URL>` (the template is too big to pass inline), wait for `CREATE_COMPLETE`, and copy
**RoleArn** from the stack's outputs.

## 6. Connect workspace 1 (still single-team)

```bash
cli cutover-connect arn:aws:iam::<account>:role/OpsConsoleAccess-af-south-1
cli cutover-check
```

This:
- verifies the role, assuming it with the external ID;
- links the existing GitHub App installations to workspace 1, so pushes keep deploying;
- sets the apps domain to `glenify.studio`.

The role covers every region, so the eu-west-1 server keeps working.

## 7. Set the multi-company settings

These are the console's settings in SSM (`/apps/ops-console/*`). From a laptop:

```bash
put() { aws ssm put-parameter --region af-south-1 --name "/apps/ops-console/$1" --type SecureString --value "$2" --overwrite >/dev/null; }
put OPS_MULTI_TENANT 1
put PUBLIC_URL https://ops.glenify.studio
put CONNECT_TEMPLATE_URL '<from step 3>'
put SERVER_BUNDLE_URL '<from step 3>'
put SERVER_BUNDLE_SHA256 '<from step 3>'
put PAYSTACK_SECRET_KEY '<sk_test_… for now; sk_live_… at launch>'
put PRODUCT_NAME 'Ops Console'
put LEGAL_ENTITY '<company name for the footer and legal pages>'
put SUPPORT_EMAIL '<support address>'
put INVOICE_SELLER '<company|address|registration and VAT numbers>'
put GITHUB_WEBHOOK_URL https://ops.glenify.studio/api/github/webhook
```

`PLATFORM_ADMINS` is optional: admins of workspace 1 are platform admins already.

## 8. Switch

```bash
# on the server
sudo systemctl restart app-secrets@ops-console ops-console
curl -s https://ops.glenify.studio/api/account/config     # → "multiTenant":true
```

## 9. Verify

- [ ] Sign in with the usual admin username: the Overview shows both servers and all apps.
- [ ] Settings → AWS account shows the connected account; a server page refreshes (status via the role).
- [ ] Settings → GitHub lists the linked installation; push a small change to a linked repo, and it deploys.
- [ ] Signed out, `https://ops.glenify.studio/` shows the landing page; `/docs` and `/terms` load.
- [ ] Sign up a test company in a private window: the welcome screen appears and it sees nothing of workspace 1.
- [ ] Paystack: set the webhook URL to `https://ops.glenify.studio/api/billing/paystack` in the Paystack dashboard.

## 10. GitHub for customers (once)

For customers to install the app themselves, update the existing GitHub App on github.com
(Settings → Developer settings → GitHub Apps → the app):

- **Callback URL:** `https://ops.glenify.studio/github/installed`.
- **Request user authorization (OAuth) during installation:** ticked.
- **Generate a client secret.** Then, in the console (Settings → GitHub, as a platform admin), paste the Client ID
  and secret.
- **Make the app public**, so other GitHub accounts can install it.

## Rollback

```bash
aws ssm put-parameter --region af-south-1 --name /apps/ops-console/OPS_MULTI_TENANT --type SecureString --value 0 --overwrite
# on the server
sudo systemctl restart app-secrets@ops-console ops-console
```

The data is unchanged: multi-company mode only adds tables and columns. Customer workspaces created in the meantime
stay in the database but aren't reachable in single-team mode.

## Before taking real customers

- **SES production access:** in sandbox mode, emails reach only verified addresses. Request it in the SES console.
- **Live Paystack key** and the webhook (step 9).
- **Terms, Privacy and Security pages:** reviewed by a South African attorney.
