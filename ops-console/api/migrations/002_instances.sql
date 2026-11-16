-- Ops Console schema, Phase 2: managed EC2 instances and their metric history.

CREATE TABLE instances (
    id               serial PRIMARY KEY,
    name             text NOT NULL,
    aws_instance_id  text NOT NULL UNIQUE,
    region           text NOT NULL,
    environment      text NOT NULL DEFAULT 'production',
    added_by         integer REFERENCES users (id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    last_status      jsonb,              -- latest normalised snapshot (served from here, refreshed via SSM)
    last_fetched_at  timestamptz,
    last_ok_at       timestamptz,
    last_error       text
);

CREATE TABLE instance_samples (
    id            bigserial PRIMARY KEY,
    instance_id   integer NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
    at            timestamptz NOT NULL DEFAULT now(),
    mem_pct       real,
    swap_pct      real,
    disk_pct      real,
    load1         real,
    apps_healthy  integer,
    apps_total    integer
);
CREATE INDEX instance_samples_lookup ON instance_samples (instance_id, at DESC);
