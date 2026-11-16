-- Ops Console schema, Phase 9: cached Cost Explorer results (each Cost Explorer request costs USD 0.01).
CREATE TABLE cost_snapshots (
    id          serial PRIMARY KEY,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    data        jsonb NOT NULL
);
CREATE INDEX cost_snapshots_recent ON cost_snapshots (fetched_at DESC);
