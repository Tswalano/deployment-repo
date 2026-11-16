# Ops Console: plan

This replaces the read-only Python ops dashboard with a proper application. It's a **React + Tailwind**
frontend with its own **login and user database**, it can manage **multiple EC2 instances**, and it's
safe to show on the portfolio.

Status: **agreed, being built in phases.** Decisions: public demo uses the `viewer` role, logs are hidden from viewers, domain is `ops.glenify.studio`.

---

## 1. What it does

| Area | Admin | Deployer | Viewer |
|---|:-:|:-:|:-:|
| See instances, apps, health, memory, databases, deploy history | ✅ | ✅ | ✅ |
| Live "deploying now" view | ✅ | ✅ | ✅ |
| App logs | ✅ | ✅ | ❌ (hidden: logs can contain personal data) |
| **Trigger a deploy** (any app, branch `main` only) | ✅ | ✅ (rate-limited) | ❌ |
| Rollback, secrets cutover, restart | ✅ | ❌ | ❌ |
| **Settings → add/remove EC2 instances** | ✅ | ❌ | ❌ |
| **Users → create, disable, change role, reset password** | ✅ | ❌ | ❌ |

- **You** get an `admin` account.
- **Portfolio visitors:** I recommend a public **demo login** with the `viewer` role, shown on the
  login page as "Try the demo". ❓ You mentioned letting some users *deploy*. That's the `deployer`
  role. Giving it to *anonymous* portfolio visitors means strangers could trigger production deploys.
  Each deploy runs `npm ci` on a 1 GB box, so repeated deploys can starve the apps of memory.
  Suggestion: `viewer` for the public demo, and `deployer` only for people you invite. If you want
  visitors to see a deploy happen, the demo can include a **"simulate deploy"** that animates the
  pipeline steps without touching the server.

## 2. Architecture

```
 Browser (React + Tailwind, built in GitHub Actions)
    │  HTTPS  ops.glenify.studio  (nginx + Let's Encrypt, already on the box)
    ▼
 ops-console API (Node 18 + Hono, ~70 MB)          Postgres 15 (existing, localhost)
   • auth, users, roles, sessions, audit log ───▶  database `opsconsole`, role `opsconsole`
   • instances registry                              (least privilege: owns only its own DB)
   • talks to each managed instance via AWS SSM
    │
    │  AWS SSM Run Command (IAM, no SSH, no open ports)
    ▼
 Managed EC2 instance(s)
   • ops agent (today's Python dashboard, read-only JSON on 127.0.0.1:9100)
   • deployment pipeline (/opt/deploy/server/pipeline.sh)
```

- **Why SSM, not SSH or a public agent API:** adding an instance needs only its ID and region. No
  keys or open ports are involved, and access follows IAM. The console reads an instance's status by
  running `curl localhost:9100/api/status` on it through SSM, cached for 30s. It deploys by running
  the same `pipeline.sh` I've been running.
- **Requirements for an instance to be addable:** the SSM agent is online, its instance profile
  allows SSM, and it carries the tag `ops-console=managed`. The console's IAM permission to send
  commands is limited to tagged instances.
- **Building:** a t3.micro can't build a React app or large TypeScript (the `tsc` OOM we hit). So
  GitHub Actions builds both the SPA and the API, and the pipeline ships the build output.

## 3. Security
- **Passwords:** Node's built-in `scrypt` (no native dependencies), with per-user salts.
- **Sessions:** server-side, in Postgres. Cookies are `HttpOnly`, `Secure` and `SameSite=Strict`,
  and expire after 12h, or 30 min for the demo account.
- **Abuse protection:** login rate limiting with lockout, and an `Origin` check on every state-changing
  request (CSRF).
- **Audit log:** every login, deploy, user change and instance change is recorded as who, what and when.
- **Deploys:** one at a time (the pipeline already locks), `main` only, and at most 1 per app per 10
  minutes for deployers.
- **The demo account can't change its own password** and is reset nightly.
- **Secrets never reach the browser.** Env var names only, as today.

## 4. Phases (each one is a PR you can review)

| # | Phase | Delivers |
|---|---|---|
| 1 | **Foundation** | `ops-console/` app skeleton (api + web), `opsconsole` database and role, migrations, login/logout, sessions, users and roles, your admin account, Users page |
| 2 | **Instances** | Settings → add/remove instances (validated via SSM), per-instance overview (the current dashboard, rebuilt in React), IAM additions |
| 3 | **Apps and deploys** | App pages (health, memory, logs, DB tables, commits), deploy button (deployer and admin), live progress, audit log |
| 4 | **Portfolio mode and go-live** | Demo login, rate limits, CI build and deploy, nginx and HTTPS on `ops.glenify.studio`, retire the Python dashboard's public route (it stays as the per-instance agent) |

## 5. Decisions
1. **Public demo:** `viewer` role ("Try the demo" on the login page, read-only, reset nightly). Deployers are invited users only.
2. **Logs for viewers:** hidden.
3. **Domain:** `ops.glenify.studio`.
4. **Admin account:** created during Phase 1. The username is chosen at creation, and the password is generated and stored in SSM, never shown in logs.
