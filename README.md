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

## Repository layout

```
deploy.sh                    # entry point (laptop or CI): syncs pipeline to the server and runs it
server/pipeline.sh           # runs ON the server: deploy / rollback / status / history
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
| `DEPLOY_HOST` | secret | `lendifyapi.glenify.studio` (or the Elastic IP) |
| `DEPLOY_SSH_KEY` | secret | full contents of the private key for `ec2-user` |
| `DEPLOY_USER` | variable (optional) | defaults to `ec2-user` |

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
2. **Create the systemd unit** from [`templates/app.service`](templates/app.service). Use a free port; 3000, 4000 and 8088 are taken. Keep secrets in a `chmod 600` env file, not in the unit.
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

## Recommended follow-ups (not done by this PR)

These are server changes, so they were deliberately left for you to approve:

- [ ] Add a 1–2 GB swap file (`npm ci` can be OOM-killed during deploys)
- [ ] Move LiftParcel's inline secrets out of the systemd unit and **rotate** them
- [ ] One least-privilege DB role per app; stop using `postgres` from the apps
- [ ] Enable a daily EBS snapshot policy (DLM) and an off-box `pg_dump` to S3
- [ ] Restrict port 22 in the security group
- [ ] Run FinanceFlow and LiftParcel from compiled builds instead of `tsx`/`ts-node` (then set `BUILD_CMD`)
- [ ] Add `SuccessExitStatus=143` to `app1.service` to silence the daily false "failure"
- [ ] Confirm certbot renews before 2026-12-15 (the box is only up 12 hours a day)
- [ ] Consider making this repo private
