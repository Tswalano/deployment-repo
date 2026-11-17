-- Ops Console schema, Phase 12a: workspaces (one per customer or team) with database-enforced isolation.
--
-- Every row of customer data now carries workspace_id. Postgres row-level security (forced, so it also applies
-- to the table owner the console connects as) only shows and accepts rows of the workspace the console sets per
-- request in app.workspace_id. An unset workspace sees nothing and can write nothing. Background jobs that must
-- see every workspace opt in explicitly with app.bypass = 'on'.
--
-- Existing data (the original single-team console) becomes workspace 1. Nothing is deleted.

CREATE TABLE workspaces (
    id             serial PRIMARY KEY,
    name           text NOT NULL,
    slug           text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
    plan           text NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial', 'starter', 'pro', 'internal')),
    trial_ends_at  timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     integer REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO workspaces (id, name, slug, plan) VALUES (1, 'My workspace', 'default', 'internal');
SELECT setval(pg_get_serial_sequence('workspaces', 'id'), 1);

CREATE TABLE workspace_members (
    workspace_id integer NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         text NOT NULL CHECK (role IN ('admin', 'deployer', 'viewer')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members (user_id);
INSERT INTO workspace_members (workspace_id, user_id, role) SELECT 1, id, role FROM users;

-- Invitations by email (a signed token; only its hash is stored).
CREATE TABLE workspace_invites (
    id           serial PRIMARY KEY,
    workspace_id integer NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email        text NOT NULL,
    role         text NOT NULL CHECK (role IN ('admin', 'deployer', 'viewer')),
    token_hash   text NOT NULL UNIQUE,
    invited_by   integer REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    accepted_at  timestamptz
);
CREATE UNIQUE INDEX workspace_invites_open ON workspace_invites (workspace_id, lower(email)) WHERE accepted_at IS NULL;

-- Accounts: email (sign-up / sign-in), verification and password reset tokens; the session remembers its workspace.
ALTER TABLE users ADD COLUMN email text, ADD COLUMN email_verified_at timestamptz;
CREATE UNIQUE INDEX users_email_lower ON users (lower(email)) WHERE email IS NOT NULL;
CREATE TABLE user_tokens (
    token_hash  text PRIMARY KEY,
    user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose     text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz
);
ALTER TABLE sessions ADD COLUMN workspace_id integer REFERENCES workspaces(id) ON DELETE SET NULL;
UPDATE sessions SET workspace_id = 1;

-- ------------------------------------------------------------------ workspace_id on every table of customer data
CREATE FUNCTION current_workspace() RETURNS integer LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('app.workspace_id', true), '')::integer $$;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['instances', 'instance_samples', 'db_samples', 'deployments', 'backup_verifications',
        'uptime_checks', 'uptime_daily', 'alerts', 'notifications', 'settings', 'audit_log', 'app_creations', 'app_repos',
        'github_deliveries', 'ssh_grants', 'terminal_sessions', 'security_snapshots', 'cost_snapshots']
    LOOP
        EXECUTE format('ALTER TABLE %I ADD COLUMN workspace_id integer REFERENCES workspaces(id) ON DELETE CASCADE', t);
        EXECUTE format('UPDATE %I SET workspace_id = 1', t);
        -- new rows take the workspace of the request (or job) that writes them; none set = the insert fails
        EXECUTE format('ALTER TABLE %I ALTER COLUMN workspace_id SET DEFAULT current_workspace(), ALTER COLUMN workspace_id SET NOT NULL', t);
        EXECUTE format('CREATE INDEX %I ON %I (workspace_id)', t || '_workspace', t);
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format($p$CREATE POLICY workspace_isolation ON %I
            USING (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace())
            WITH CHECK (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace())$p$, t);
    END LOOP;
END $$;

-- keys that were global become per workspace
ALTER TABLE settings DROP CONSTRAINT settings_pkey, ADD PRIMARY KEY (workspace_id, key);
DROP INDEX alerts_one_open;
CREATE UNIQUE INDEX alerts_one_open ON alerts (workspace_id, key) WHERE resolved_at IS NULL;
ALTER TABLE instances DROP CONSTRAINT instances_aws_instance_id_key, ADD CONSTRAINT instances_workspace_aws_id UNIQUE (workspace_id, aws_instance_id);
