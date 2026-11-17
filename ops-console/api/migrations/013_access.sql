-- Ops Console schema, Phase 11: server access.

-- Temporary SSH rules the console opened on a security group; closed again when they expire.
CREATE TABLE ssh_grants (
    id          serial PRIMARY KEY,
    instance_id integer NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
    group_id    text NOT NULL,
    cidr        text NOT NULL,
    reason      text,
    granted_by  text NOT NULL,
    granted_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz,
    revoked_by  text,
    error       text
);
CREATE UNIQUE INDEX ssh_grants_open ON ssh_grants (instance_id, group_id, cidr) WHERE revoked_at IS NULL;

-- Browser terminal sessions (who, when, how long; never what was typed).
CREATE TABLE terminal_sessions (
    id          serial PRIMARY KEY,
    instance_id integer REFERENCES instances(id) ON DELETE SET NULL,
    session_id  text,
    username    text NOT NULL,
    ip          text,
    simulated   boolean NOT NULL DEFAULT false,
    started_at  timestamptz NOT NULL DEFAULT now(),
    ended_at    timestamptz,
    end_reason  text
);
CREATE INDEX terminal_sessions_instance ON terminal_sessions (instance_id, started_at DESC);

-- Last security snapshot per instance (keys, logins, updates), refreshed on demand.
CREATE TABLE security_snapshots (
    instance_id integer PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
    at          timestamptz NOT NULL DEFAULT now(),
    data        jsonb NOT NULL
);
