-- Ops Console schema, Phase 5: uptime history, alerts and notification settings.

-- One row per probe of an app's public health URL (every minute while the console runs; kept 30 days).
CREATE TABLE uptime_checks (
    id           bigserial PRIMARY KEY,
    instance_id  integer NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
    project      text NOT NULL,
    at           timestamptz NOT NULL DEFAULT now(),
    ok           boolean NOT NULL,
    status       integer,
    ms           integer,
    error        text
);
CREATE INDEX uptime_checks_lookup ON uptime_checks (instance_id, project, at DESC);

-- Daily roll-up (kept ~13 months) so 90-day history stays cheap after raw checks expire.
CREATE TABLE uptime_daily (
    instance_id  integer NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
    project      text NOT NULL,
    day          date NOT NULL,
    checks       integer NOT NULL,
    ok           integer NOT NULL,
    p50_ms       integer,
    p95_ms       integer,
    PRIMARY KEY (instance_id, project, day)
);

CREATE TABLE alerts (
    id                serial PRIMARY KEY,
    key               text NOT NULL,                 -- identity of the condition, e.g. app_down:1:lendify
    rule              text NOT NULL,
    severity          text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
    instance_id       integer REFERENCES instances (id) ON DELETE CASCADE,
    project           text,
    title             text NOT NULL,
    detail            text NOT NULL DEFAULT '',
    opened_at         timestamptz NOT NULL DEFAULT now(),
    last_seen_at      timestamptz NOT NULL DEFAULT now(),
    resolved_at       timestamptz,
    acked_by          text,
    acked_at          timestamptz,
    last_notified_at  timestamptz,
    notify_count      integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX alerts_one_open ON alerts (key) WHERE resolved_at IS NULL;
CREATE INDEX alerts_recent ON alerts (opened_at DESC);

CREATE TABLE notifications (
    id        bigserial PRIMARY KEY,
    alert_id  integer REFERENCES alerts (id) ON DELETE SET NULL,
    kind      text NOT NULL,                         -- opened | reminder | resolved | test
    channel   text NOT NULL,                         -- email | webhook
    ok        boolean NOT NULL,
    error     text,
    at        timestamptz NOT NULL DEFAULT now()
);

-- Small key/value store for console settings (alert recipients, thresholds, …).
CREATE TABLE settings (
    key         text PRIMARY KEY,
    value       jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  text
);
