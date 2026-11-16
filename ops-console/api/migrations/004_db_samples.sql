-- Ops Console schema, Phase 4: database metric history (counters sampled ~every 5 minutes, kept 7 days).
-- Rates (transactions/s, cache hit %, growth) are derived from consecutive samples.

CREATE TABLE db_samples (
    id             bigserial PRIMARY KEY,
    instance_id    integer NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
    db             text NOT NULL,
    at             timestamptz NOT NULL DEFAULT now(),
    size           bigint,
    connections    integer,
    xact_commit    bigint,
    xact_rollback  bigint,
    blks_hit       bigint,
    blks_read      bigint,
    deadlocks      bigint
);
CREATE INDEX db_samples_lookup ON db_samples (instance_id, db, at DESC);
