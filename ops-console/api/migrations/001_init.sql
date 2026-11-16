-- Ops Console schema, Phase 1: users, sessions, audit log.

CREATE TABLE users (
    id               serial PRIMARY KEY,
    username         text NOT NULL,
    display_name     text NOT NULL DEFAULT '',
    role             text NOT NULL CHECK (role IN ('admin', 'deployer', 'viewer')),
    password_hash    text,                      -- NULL for the passwordless demo account
    is_demo          boolean NOT NULL DEFAULT false,
    disabled         boolean NOT NULL DEFAULT false,
    failed_logins    integer NOT NULL DEFAULT 0,
    locked_until     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    last_login_at    timestamptz,
    password_changed_at timestamptz
);
CREATE UNIQUE INDEX users_username_lower ON users (lower(username));
-- at most one demo account
CREATE UNIQUE INDEX users_single_demo ON users (is_demo) WHERE is_demo;

CREATE TABLE sessions (
    token_hash   text PRIMARY KEY,               -- sha256 of the cookie value; the raw token is never stored
    user_id      integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    ip           text,
    user_agent   text
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE audit_log (
    id        bigserial PRIMARY KEY,
    at        timestamptz NOT NULL DEFAULT now(),
    user_id   integer REFERENCES users (id) ON DELETE SET NULL,
    username  text,                               -- kept even if the user is deleted
    action    text NOT NULL,                      -- e.g. auth.login, user.create, user.role
    target    text,
    detail    jsonb NOT NULL DEFAULT '{}',
    ip        text
);
CREATE INDEX audit_log_at ON audit_log (at DESC);
