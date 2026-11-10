# deployment-repo

A deployment pipeline for the **multi-project EC2 host** `lendify-instance` (af-south-1),
kept separate from the application repos.

Each application keeps its own repo. This repo only knows **where** each app lives on
the server, **how** to build it, and **how to check it is healthy**. Adding a project
means adding one small config file.

```
┌──────────────┐   ./deploy.sh / GitHub Actions    ┌────────────────────── EC2 (lendify-instance) ───────────────────────┐
│ this repo    │ ─── ssh + rsync pipeline ───────▶ │ /opt/deploy/server/pipeline.sh                                       │
│  projects/*  │                                   │   for each project:                                                  │
│  server/*    │                                   │   lock → backup DB → git fetch/checkout → [sync] → install → build   │
└──────────────┘                                   │   → [migrate] → systemctl restart → health check → auto-rollback     │
                                                   │                                                                      │
  app repos (GitHub) ◀── git fetch (server's ──────│  nginx :443 ─┬─ financeapi.glenify.studio → :3000  app1 (FinanceFlow)│
  own deploy keys)                                 │              ├─ lendifyapi.glenify.studio → :8088  lendify            │
                                                   │              └─ liftapi.glenify.studio    → :4000  liftparcel         │
                                                   │  PostgreSQL 15 :5432 (localhost) — financeflow, lendify, liftparcel  │
                                                   └──────────────────────────────────────────────────────────────────────┘
```

> 📋 **Full audit of the server** (processes, failures, security findings, database details):
> [`docs/server-inventory.md`](docs/server-inventory.md)

---

## Projects on the server

| Project (`projects/*.conf`) | systemd unit | Port | Domain | Source repo → folder | Notes |
|---|---|---|---|---|---|
| `financeflow` | `app1` | 3000 | financeapi.glenify.studio | `Tswalano/loan_managementv2` → `backend/` | Hono + Drizzle, runs `tsx` (dev mode) |
| `lendify` | `lendify` | 8088 | lendifyapi.glenify.studio | `Tswalano/MoneyLook` → `backend/` | Hono + Prisma, compiled `dist/`. **Sync mode** (see below) |
| `liftparcel` | `liftparcel` | 4000 | liftapi.glenify.studio | `Tswalano/svelte-delivery-app` → `api/` | Node + Drizzle, runs `ts-node` (dev mode) |

All three were **healthy** at the time of the audit. The only "failure" in the logs is
`app1` exiting with code 143 at 16:00 every day: that is the scheduled instance stop
sending SIGTERM to `npm`, not a crash. See the inventory for the full list of risks.

### Database (summary)

PostgreSQL **15.14** running on the instance itself (localhost-only, `/var/lib/pgsql/data`, 112 MB).
There is one database per app (`financeflow`, `lendify`, `liftparcel`, each about 8–9 MB), plus 4 empty
leftover Prisma shadow DBs. ⚠️ **No backups or snapshots exist**: the pipeline now dumps the
database before each deploy, but read the [recommendations](docs/server-inventory.md#recommendations).

---

## Secrets (SSM Parameter Store)

App secrets are **not** kept in unit files, `.env` files or this repo. They live in **AWS SSM Parameter
Store** as KMS-encrypted `SecureString`s (standard tier, which is free):

```
/apps/<SERVICE>/<ENV_VAR_NAME>      e.g.  /apps/liftparcel/JWT_SECRET
```

At every service start, systemd runs `ExecStartPre=+/usr/local/bin/load-app-secrets <SERVICE>`
([`server/load-app-secrets.sh`](server/load-app-secrets.sh)) as root. It uses the instance role to fetch
`/apps/<SERVICE>/*` and writes `/run/app-secrets/<SERVICE>.env`, which is on tmpfs and `0600 root`, so
it is never written to disk. The unit reads that file with `EnvironmentFile=`. The unit files in
[`systemd/`](systemd/) therefore contain only `PORT` and `NODE_ENV`.

| Task | Command |
|---|---|
| Add / change a secret | `aws ssm put-parameter --name /apps/<svc>/<KEY> --type SecureString --value '…' --overwrite` and then restart (or deploy) the service |
| List keys (no values) | `aws ssm get-parameters-by-path --path /apps/<svc> --query 'Parameters[].Name'` |
| Remove a secret | `aws ssm delete-parameter --name /apps/<svc>/<KEY>` and then restart |

> Avoid `--value` on shared machines, because it ends up in your shell history. Use `--cli-input-json file://…` instead.

The instance can only **read** `/apps/*` (policy: [`infra/iam/instance-read-app-secrets.json`](infra/iam/instance-read-app-secrets.json)).
Why Parameter Store rather than Secrets Manager: it's free at this scale ($0.40 per secret per month
on Secrets Manager × 31 values), and none of these secrets need automatic rotation. Secrets Manager is
worth it for the database password once each app has its own role and rotation is wanted.

**One-time cutover** (moves each app from inline/.env secrets to SSM, with verification and auto-restore):

```bash
./scripts/setup-aws-iam.sh                 # instance role + GitHub OIDC role (needs IAM admin)
./deploy.sh secrets-cutover liftparcel     # one at a time is safest; or: all
```

[`server/secrets-cutover.sh`](server/secrets-cutover.sh) works through each project in order:

1. Checks that the SSM values are **byte-identical** to the running process's environment.
2. Backs up the old unit and `.env` to `/root/secrets-cutover-backup/`.
3. Installs the new unit and restarts the service.
4. Checks health **and** that the new process sees identical values.
5. Restores the old unit if anything is off.

When you're happy, delete the backup folder, since it contains the old plaintext values.

---

## Ops dashboard

A read-only status page for the box: RAM, swap and disk; each app's systemd state, health, memory,
deployed commit, warnings in the last 24h and recent deploys; Postgres databases, sizes, tables and
connections; system services; and TLS certificate expiry.

- [`ops-dashboard/app.py`](ops-dashboard/app.py) uses only the Python standard library (system python3.9, about 15 MB RAM), plus [`index.html`](ops-dashboard/index.html). The page auto-refreshes every 10s, and the JSON is at `/api/status`.
- It reads `projects/*.conf`, so **new projects appear automatically**.
- It's **read-only** and changes nothing:
  - runs as the `opsdash` system user under a hardened systemd unit (`ProtectSystem=strict`, `MemoryMax=96M`)
  - listens on `127.0.0.1:9100` only
  - queries the DB as `ops_monitor`, a member of `pg_monitor` with no superuser rights and a 5-connection limit

**Install (one-time):**
```bash
# 1. two random passwords into SSM (never printed)
for n in /apps/ops-dashboard/PGPASSWORD /apps/ops-dashboard-auth/PASSWORD; do
  aws ssm put-parameter --region af-south-1 --name "$n" --type SecureString \
    --value "$(python3 -c 'import secrets;print(secrets.token_urlsafe(30))')"
done
# 2. install the service
./deploy.sh ops-dashboard install
```

**View it** in one of these ways:
- **Tunnel (nothing public):** `ssh -L 9100:127.0.0.1:9100 ec2-user@<host>`, then open <http://localhost:9100>. With SSM instead:
  `aws ssm start-session --target <instance-id> --document-name AWS-StartPortForwardingSession --parameters portNumber=9100,localPortNumber=9100`
- **Public with a password:**
  1. Add an `A` record `ops.glenify.studio → <Elastic IP>`.
  2. Run `./deploy.sh ops-dashboard expose ops.glenify.studio`. This sets up nginx, basic auth and a Let's Encrypt certificate.
  3. Log in as user `ops`. Get the password with
     `aws ssm get-parameter --name /apps/ops-dashboard-auth/PASSWORD --with-decryption --query Parameter.Value --output text`

---

## Repository layout

```
deploy.sh                    # entry point (laptop or CI): syncs pipeline to the server and runs it
server/pipeline.sh           # runs ON the server: deploy / rollback / status / history / secrets-cutover
server/load-app-secrets.sh   # installed as /usr/local/bin/load-app-secrets (SSM → /run/app-secrets/<svc>.env)
server/secrets-cutover.sh    # one-time migration of an app's secrets to SSM, with verification + auto-restore
systemd/<service>.service    # source of truth for the unit files (no secrets)
infra/iam/*.json             # IAM policies: instance role + GitHub OIDC deploy role
scripts/setup-aws-iam.sh     # creates/updates those roles and attaches the instance profile
ops-dashboard/               # read-only status page (stdlib Python) served on 127.0.0.1:9100
server/install-ops-dashboard.sh  # installs it (install) and optionally publishes it with auth + TLS (expose)
projects/<name>.conf         # one file per project (files starting with "_" are ignored)
projects/_template.conf      # documented template for new projects
templates/                   # systemd unit, nginx site and "trigger from app repo" workflow templates
.github/workflows/deploy.yml # GitHub Actions: manual dispatch + repository_dispatch
docs/server-inventory.md     # audit of the server as of 2026-11-10
```

## How a deploy works

For each project, `server/pipeline.sh deploy <project> [ref]`:

1. Takes a **host-wide lock** (`flock`), so only one deploy runs at a time. The t3.micro has ~100 MB of free RAM, so projects deploy **one after another**, never in parallel.
2. **Refuses** to continue if the server's git checkout has uncommitted changes (override with `FORCE=1`).
3. *Sync-mode only:* takes a tarball snapshot of the running directory.
4. `pg_dump`s the project's database to `/opt/deploy-state/<project>/backups/` (keeps the last 10).
5. `git fetch` + checks out the requested ref as a **detached, exact SHA**. The server pulls with **its own deploy keys**, so private app repos work without giving CI any GitHub access to them.
6. *Sync-mode only:* `rsync`s `SOURCE_DIR/APP_SUBDIR` → `RUN_DIR` (keeps `.env*`, `node_modules`, `dist`).
7. Runs `INSTALL_CMD` → `BUILD_CMD` → `MIGRATE_CMD` (any of them can be left empty).
8. `sudo systemctl restart <SERVICE>`.
9. Polls `HEALTH_URL` until it returns 2xx (default timeout 90 s).
10. On failure it **rolls back automatically** to the previous SHA and exits non-zero.
11. Writes the result to `/opt/deploy-state/<project>/history.log`.

**Sync mode:** Lendify runs from `~/lendify`, which is a plain copy and not a git checkout. Its
config sets `RUN_DIR`, so the pipeline pulls into the MoneyLook clone at `/opt/apps/app2`
and rsyncs `backend/` across. If you later point the systemd unit at
`/opt/apps/app2/backend`, delete `RUN_DIR` from `projects/lendify.conf` and it becomes a
normal project.

---

## Usage

### One-time setup

**1. Connection.** Pick one of these:

- **SSH key:** `DEPLOY_SSH_KEY=~/path/to/test-api.pem`
- **EC2 Instance Connect** (no `.pem` needed, uses your AWS CLI credentials, which need `ec2-instance-connect:SendSSHPublicKey`): `EC2_INSTANCE_ID=i-…`

```bash
cp .deploy.env.example .deploy.env   # git-ignored; fill in host + key or instance id
```

**2. On the server: let the pipeline take DB backups.** Do this once. `~/.pgpass` must be `chmod 600`:

```bash
echo 'localhost:5432:*:postgres:<postgres-password>' >> ~/.pgpass && chmod 600 ~/.pgpass
```

Without it, deploys still run but print a backup warning. Projects that have `MIGRATE_CMD` set **refuse** to deploy without a backup.

**3. Clean up the server checkouts before the first deploy.** The audit found local, uncommitted file deletions:

- `/opt/apps/app1`: removed `backend-server/`
- `/opt/apps/liftparcel`: removed `.pem` files

Commit those deletions in the app repos (and **remove those `.pem` files from git history / rotate those keys**). Otherwise the first deploy needs `FORCE=1`, which restores the deleted files from git.

**4. GitHub Actions.** Under **Settings → Secrets and variables → Actions**, add:

| Name | Type | Value |
|---|---|---|
| `DEPLOY_HOST` | variable | `lendifyapi.glenify.studio` (resolves to the Elastic IP) |
| `EC2_INSTANCE_ID` | variable | the instance id (printed by `scripts/setup-aws-iam.sh`) |
| `DEPLOY_USER` | variable (optional) | defaults to `ec2-user` |
| `AWS_DEPLOY_ROLE_ARN` | secret | printed by `scripts/setup-aws-iam.sh`. This OIDC role is the **only** credential CI uses: no AWS keys and no SSH key/PEM are stored in GitHub |
| `DEPLOY_SG_ID` | variable | the instance's security group id (printed by the same script) |

**No PEM needed.** CI connects with **EC2 Instance Connect**: the OIDC role pushes a throwaway public key for
`ec2-user`, valid for 60 seconds, and `deploy.sh` uses it straight away. Locally it works the same way with
your AWS CLI credentials. Set `EC2_INSTANCE_ID` in `.deploy.env` and leave `DEPLOY_SSH_KEY` unset.

**Port 22 is restricted** to the admin IP and the EC2 Instance Connect range. Each workflow run uses the
OIDC role to allow **its own runner IP** for the length of the job, and always revokes it at the end.
For local runs from a new IP, add it first:
`aws ec2 authorize-security-group-ingress --group-id <sg> --protocol tcp --port 22 --cidr $(curl -s https://checkip.amazonaws.com)/32`
(or connect through the EC2 console / SSM Session Manager).

Also create an environment called `production` (**Settings → Environments**). Add required reviewers there if you want every deploy to need approval.

> The instance only runs **04:00–16:00 UTC**. Deploys outside that window will fail to connect.

### Deploy everything

```bash
./deploy.sh deploy all
```

Actions → **Deploy** → Run workflow → action `deploy`, project `all`.

Projects deploy one after another, each on its own configured `BRANCH`. If one fails, it
rolls itself back and the rest still run. The run exits non-zero and lists which projects failed.

### Deploy one project

```bash
./deploy.sh deploy liftparcel              # latest of BRANCH (main)
./deploy.sh deploy liftparcel dev-2        # a branch
./deploy.sh deploy liftparcel 94614d1      # an exact commit
```

Actions → **Deploy** → action `deploy`, project `liftparcel`, ref (optional).

### Status and history

```bash
./deploy.sh status all
#  financeflow  app1   unit=active  health=200  sha=c176523a  branch=main  financeapi.glenify.studio
./deploy.sh history lendify
```

### Rollback strategy

| Situation | What happens / what to run |
|---|---|
| New release fails its health check | **Automatic.** The pipeline redeploys the previous SHA and the run fails, so you notice. |
| Release is healthy but broken in practice | `./deploy.sh rollback <project>` goes back to the release before the current one. Run it again to step back further. |
| Need a specific version | `./deploy.sh rollback <project> <sha>` (any SHA from `history`) |
| Sync-mode project (Lendify) and git history isn't enough | `./deploy.sh restore-snapshot lendify [file]` restores the tarball taken before the last deploy |
| A **migration** broke the data | Migrations are *not* reverted automatically. Restore the dump taken just before the deploy:<br>`gunzip -c /opt/deploy-state/<p>/backups/<db>-<ts>-<sha>.sql.gz \| psql -U postgres -h localhost <db>` (into a fresh DB, or after dropping it), then roll back the code |
| Whole box is lost | Rebuild from an EBS snapshot. ⚠️ **None exist yet.** Enable a DLM policy (see inventory). |

Rollbacks never run migrations and are never blocked by a dirty checkout.

Every run records `timestamp sha ref status action` in `/opt/deploy-state/<project>/history.log`.

### Flags

| Env var | Effect |
|---|---|
| `FORCE=1` | Discard uncommitted changes in the server checkout before deploying |
| `SKIP_DB_BACKUP=1` | Skip the pre-deploy `pg_dump` |
| `NO_AUTO_ROLLBACK=1` | Leave a failed release running so you can debug it |
| `HEALTH_TIMEOUT=180` | Override the health-check timeout |

---

## Adding a new project

1. **Put the code on the server** and make sure the server can pull it. For a private repo, add a **deploy key**:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/<name>_deploy -N ''
   # add ~/.ssh/<name>_deploy.pub as a read-only deploy key in the GitHub repo, then in ~/.ssh/config:
   #   Host <name>
   #     HostName github.com
   #     IdentityFile ~/.ssh/<name>_deploy
   git clone git@<name>:Tswalano/<repo>.git /opt/apps/<name>
   ```
2. **Create the systemd unit** from [`templates/app.service`](templates/app.service). Use a free port; 3000, 4000 and 8088 are taken. Put secrets in SSM as `/apps/<SERVICE>/<KEY>` (see [Secrets](#secrets-ssm-parameter-store)), never in the unit. Commit the finished unit to `systemd/<SERVICE>.service`.
   ```bash
   sudo systemctl daemon-reload && sudo systemctl enable --now <name>
   ```
3. **Expose it** with [`templates/nginx-site.conf`](templates/nginx-site.conf):
   - add a DNS A record pointing to the Elastic IP
   - `sudo nginx -t && sudo systemctl reload nginx`
   - `sudo certbot --nginx -d <domain>`
4. **Register it with the pipeline:**
   ```bash
   cp projects/_template.conf projects/<name>.conf   # fill in SERVICE, SOURCE_DIR, HEALTH_URL, …
   ```
   The file name becomes the project name. It is picked up automatically by `deploy all`, `status all` and the workflow.
5. **Test it:** `./deploy.sh status <name>`, then `./deploy.sh deploy <name>`.
6. *(Optional)* **Auto-deploy on push:** copy [`templates/trigger-from-app-repo.yml`](templates/trigger-from-app-repo.yml) into the app repo and add a `DEPLOY_REPO_TOKEN` secret there.

> 💾 Every project adds memory pressure on a ~1 GB t3.micro. Add swap, or move up to a
> larger instance, before adding a fourth Node app.

---

## Recommended follow-ups

Done on 2026-11-10 (see [inventory → changes made](docs/server-inventory.md#changes-made-on-2026-11-10)):
- [x] Restrict port 22 in the security group
- [x] Confirm certbot renews (`--dry-run` succeeded for all 3 certificates)
- [x] Drop the 4 empty Prisma shadow databases
- [x] LiftParcel moved onto Drizzle migrations (baselined, so `MIGRATE_CMD` is now enabled)
- [x] All 31 app secrets copied to SSM Parameter Store and verified
- [ ] **Secrets cutover**: run `scripts/setup-aws-iam.sh`, then `./deploy.sh secrets-cutover all`

Still open:
- [ ] **Rotate** the secrets that have been in plaintext (LiftParcel JWT/Paystack/Sentry/Mapbox, Lendify JWT and email password, and the Postgres password), then update them in SSM
- [ ] Add a 1–2 GB swap file (`npm ci` can be OOM-killed during deploys)
- [ ] One least-privilege DB role per app; stop using `postgres` from the apps
- [ ] Enable a daily EBS snapshot policy (DLM) and an off-box `pg_dump` to S3
- [ ] Run FinanceFlow and LiftParcel from compiled builds instead of `tsx`/`ts-node` (then set `BUILD_CMD`)
- [ ] Remove stale `.env` copies in `/opt/apps/app2`, `~/app2` (unused clones that still hold credentials)
- [ ] Consider making this repo private
