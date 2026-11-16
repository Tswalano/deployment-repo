-- Ops Console schema, Phase 3: deployments and rollbacks started from the console.

CREATE TABLE deployments (
    id                 serial PRIMARY KEY,
    instance_id        integer NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
    project            text NOT NULL,
    action             text NOT NULL CHECK (action IN ('deploy', 'rollback')),
    ref                text NOT NULL DEFAULT '',          -- '' = the project's default branch / previous good deploy
    requested_by       integer REFERENCES users (id) ON DELETE SET NULL,
    requested_by_name  text NOT NULL,
    command_id         text,
    status             text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
    ssm_status         text,
    output             text,                               -- pipeline log tail (deployers/admins only)
    created_at         timestamptz NOT NULL DEFAULT now(),
    finished_at        timestamptz
);
CREATE INDEX deployments_recent ON deployments (instance_id, created_at DESC);
-- At most one console deployment in flight per instance (the pipeline also holds a host-wide lock).
CREATE UNIQUE INDEX deployments_one_running ON deployments (instance_id) WHERE status = 'running';
