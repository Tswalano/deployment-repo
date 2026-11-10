# Server inventory — `lendify-instance`

Snapshot taken **2026-11-10** by logging in through the AWS CLI account
(`cli_admin_user`) with EC2 Instance Connect. Everything was **read-only**; nothing on the
server was changed.

## Host

| | |
|---|---|
| Instance | `lendify-instance`, **t3.micro** (2 vCPU, ~1 GB RAM, **no swap**) |
| Region | `af-south-1` (Cape Town) |
| OS | Amazon Linux 2023 (kernel 6.1) |
| Disk | 8 GB gp root, **57 % used** (4.5 GB / 8 GB) |
| Memory at idle | ~660 MB used, **~100 MB available** |
| Public IP | Elastic IP (stable across stop/start); all three API domains resolve to it |
| Security group | `default` — inbound **22, 80, 443 open to 0.0.0.0/0** |
| IAM instance profile | none (so not an SSM managed node, although `amazon-ssm-agent` is running) |
| Schedule | EventBridge Scheduler: `EC2_Start_Instance_Daily` (04:00 UTC) / `EC2_Stop_Instance_Daily` (16:00 UTC) |
| Runtime | Node **18.20.8**, npm 10.8.2 — no Docker, no PM2 |
| TLS | Let's Encrypt via certbot for all three domains — **expire 2026-12-15** (35 days left at time of check) |

## Projects running

All three are **systemd services** running as `ec2-user`, fronted by **nginx** (TLS termination +
reverse proxy, HTTP → HTTPS redirect).

| Project | systemd unit | Port | Public URL | Code on server | Git source | Started with | ORM / DB |
|---|---|---|---|---|---|---|---|
| **FinanceFlow API** | `app1` | 3000 | `https://financeapi.glenify.studio` | `/opt/apps/app1/backend` | `Tswalano/loan_managementv2` (`backend/`) | `npm run dev` → `tsx watch lambda/dev.ts` | Drizzle → `financeflow` |
| **Lendify API** (multi-tenant loan mgmt v2.0.0) | `lendify` | 8088 | `https://lendifyapi.glenify.studio` | `/home/ec2-user/lendify` (**not a git checkout**) | `Tswalano/MoneyLook` (`backend/`), clone at `/opt/apps/app2` | `node dist/index.js` (compiled) | Prisma → `lendify` |
| **LiftParcel API** (parcel delivery) | `liftparcel` | 4000 | `https://liftapi.glenify.studio` | `/opt/apps/liftparcel/api` | `Tswalano/svelte-delivery-app` (`api/`) | `npm run dev` → `ts-node lambda/dev.ts` | Drizzle → `liftparcel` |

Other things on the box:

- `/opt/apps/app2` — a clone of the MoneyLook repo. **Nothing runs from it**; the pipeline uses it as Lendify's source.
- `~/app2` — an older MoneyLook clone (stale, not used).
- `/var/www/react-app` — a static Vite build. **Not served** by any nginx server block.
- nginx default server on :80 (`server_name _`) proxies to Lendify (:8088).

### Health at time of check

| Endpoint | Result |
|---|---|
| `127.0.0.1:3000/health` | `200 {"status":"ok"}` |
| `127.0.0.1:8088/health` | `200 {"status":"ok","message":"Multi-Tenant Loan Management API is running","version":"2.0.0"}` |
| `127.0.0.1:4000/health` | `200 {"status":"healthy","message":"Database connection successful"}` |

`systemctl --failed` → **0 failed units**. Restart count for every service: **0**. No OOM kills in the kernel log.

## Failures and warnings found

| Severity | Finding | Detail / fix |
|---|---|---|
| 🟡 Noise | `app1.service: Failed with result 'exit-code'` **every day at 16:00** | This is the scheduled instance stop: `npm` exits **143** (SIGTERM). Not a crash. Fix: add `SuccessExitStatus=143` to the unit, or run `node`/`tsx` directly instead of through `npm`. |
| 🟡 Warning | LiftParcel: `MaxListenersExceededWarning: 11 uncaughtException listeners added to [process]` | A handler is registered repeatedly (often on every hot reload or every request). It can leak memory; worth fixing in the app code. |
| 🟠 Risk | FinanceFlow and LiftParcel run in **dev mode** in production (`tsx watch`, `ts-node`) | Slower cold starts and more memory. LiftParcel's ts-node process alone uses **~40 % of RAM**. Switch to `npm run build` + `node dist/...`. |
| 🟠 Risk | **~100 MB free RAM, no swap** | `npm ci` during a deploy can get OOM-killed. The pipeline deploys one project at a time; adding a 1–2 GB swap file is strongly recommended. |
| 🟠 Risk | Uncommitted local changes in server checkouts | `/opt/apps/app1`: 25 files deleted locally (the old `backend-server/` CDK folder), and it is **5 commits behind** `origin/main`. `/opt/apps/liftparcel`: 3 files deleted locally (`*.pem`, `session-manager-plugin.pkg`). The pipeline refuses to deploy over these until they are committed upstream (or you pass `FORCE=1`). |
| 🟠 Risk | Lendify drift | `~/lendify/src/index.ts` differs from `MoneyLook/backend/src/index.ts` on `main`. The **first** pipeline deploy of Lendify will replace it with the repo version. Commit the server copy upstream first if it has changes you need (a snapshot is taken automatically anyway). |
| 🟠 Risk | Stale `~/lendify/update.sh` | Points at an old hostname and restarts a PM2 app (`moneylook`) that no longer exists. It is replaced by this pipeline. |
| 🔴 Security | Secrets in plain text inside systemd unit files | The LiftParcel unit has JWT, payment-provider, Sentry and map tokens inline (`systemctl cat` shows them to any user). Move them to a `chmod 600` `EnvironmentFile` and **rotate** them. |
| 🔴 Security | Weak database password shared by apps, used as the Postgres superuser | Create one least-privilege role per app (Lendify already has `lendify_user`). |
| 🔴 Security | SSH (22) open to the world | Restrict it to your IP, or rely on EC2 Instance Connect / SSM. |
| 🔴 Data | **No backups at all** | No cron jobs, no dump files, **0 EBS snapshots**, no DLM policy. The pipeline now dumps a database before each deploy; also enable a daily DLM snapshot policy. |
| 🟡 Ops | TLS certificates expire 2026-12-15 | Check that certbot's renewal timer works, since the box is only up 04:00–16:00 UTC: `systemctl list-timers \| grep certbot`, `sudo certbot renew --dry-run`. |
| 🟡 Housekeeping | 4 leftover `prisma_migrate_shadow_db_*` databases (empty) | Safe to drop once confirmed. |

## Database

**PostgreSQL 15.14** (Amazon Linux package), installed directly on the instance (not RDS).

| Setting | Value |
|---|---|
| Data dir | `/var/lib/pgsql/data` (112 MB on disk) |
| Listen | `localhost:5432` only (not reachable from the internet) |
| Auth (`pg_hba`) | `md5` for local socket + 127.0.0.1/::1; replication via peer/ident |
| Password hashing | `scram-sha-256` |
| `max_connections` | 100 |
| `shared_buffers` | 160 MB |
| `wal_level` / `archive_mode` | replica / **off** (so no point-in-time recovery) |
| Roles | `postgres` (superuser, used by FinanceFlow and LiftParcel), `lendify_user` (login, non-superuser, used by Lendify) |

### Databases

| Database | Size | Used by | Migration tool | Tables | Notable row counts |
|---|---|---|---|---|---|
| `financeflow` | 8.9 MB | FinanceFlow (`app1`) | Drizzle (`drizzle.__drizzle_migrations`: 5) | 10 | transactions 53, audit_logs 92, loans 11, balances 6, organizations 2, users 1 |
| `lendify` | 8.6 MB | Lendify | Prisma (`_prisma_migrations`: 10) | 17 | activity_logs 77, sessions 7, borrowers 4, loans 3, organizations 3, users 3, stokvel_payments 3, stokvel_members 2, payments 2, stokvel_groups 1 |
| `liftparcel` | 8.4 MB | LiftParcel | Drizzle (no migrations table, so schema was applied with `db:push`) | 10 | driver_service_areas 12, delivery_timings 7, areas 5, package_areas 4, transactions 4, packages 2, payments 2, users 2 |
| `postgres` | 7.7 MB | default admin DB | — | — | — |
| `prisma_migrate_shadow_db_*` ×4 | 7.6 MB each | leftovers from `prisma migrate dev` | — | 0 | empty |

Data volumes are small (development/early-production scale). The Lendify schema covers
multi-tenant organizations, borrowers, loans, payments, interest history, subscriptions
and *stokvel* (savings group) features.

### Recommendations

1. **Backups:** create `~/.pgpass` (see the README) so the pipeline's pre-deploy `pg_dump` works, add a daily `pg_dumpall` to S3, and enable an EBS snapshot lifecycle policy.
2. **Least privilege:** give each app its own role, owning only its own database. Stop using `postgres` from apps.
3. **Migrations:** LiftParcel has no migration history. Switch from `db:push` to `drizzle-kit generate` + `migrate` before turning on `MIGRATE_CMD` in the pipeline.
4. **Growth:** with ~1 GB RAM shared by three Node apps and Postgres, consider moving the DB to RDS (`db.t4g.micro`) or the instance to t3.small/t4g.small when traffic grows.

---

## Changes made on 2026-11-10

All changes were made with explicit approval, after the audit above.

| Change | Details | Verified by | Undo |
|---|---|---|---|
| **SSH (22) restricted** | `0.0.0.0/0` removed. Now allowed: the admin IP `/32` and the EC2 Instance Connect prefix list for af-south-1. Ports 80/443 are unchanged. | SSH from the admin IP still works | `aws ec2 authorize-security-group-ingress … --cidr 0.0.0.0/0` (not recommended) |
| **Secrets copied to SSM** | 31 values (app1: 1, liftparcel: 14, lendify: 16) read from the running processes' environments into `/apps/<service>/<KEY>` SecureStrings. The apps are **not yet** reading from SSM; see the README cutover steps. | Every value hash-compared against the source: 0 mismatches | `aws ssm delete-parameters` |
| **Certbot renewal** | `certbot renew --dry-run` succeeded for all 3 domains. The timer runs twice a day with a random delay of up to 12h, and the nginx installer reloads nginx after renewal. Real renewal starts once the certs are within 30 days of expiry (~2026-11-15). | dry-run output | — |
| **Prisma shadow DBs dropped** | 4 × `prisma_migrate_shadow_db_*`. Each was re-checked immediately beforehand: 0 tables, 0 connections. | `pg_database` listing | Prisma recreates them on demand (`migrate dev`) |
| **LiftParcel migrations baselined** | The live schema was proven **identical** to `drizzle/0000–0002` (applied to a scratch DB, `pg_dump -s` diff = 0 lines), and `drizzle-kit generate` reported no pending schema changes. Created `drizzle.__drizzle_migrations` with the 3 entries (sha256 of each file plus the journal timestamps). | `drizzle-kit migrate` is a no-op (rehearsed on a scratch DB first, then on prod); API healthy | Backup taken first: `~/db-backups/liftparcel-pre-baseline-*.sql.gz`; or `drop schema drizzle cascade` |

The LiftParcel checkout was not modified. No services were restarted.
