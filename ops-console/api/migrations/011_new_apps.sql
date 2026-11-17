-- Ops Console schema, Phase 10b: apps created from a GitHub repository by the console.
ALTER TABLE deployments DROP CONSTRAINT deployments_action_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_action_check CHECK (action IN ('deploy', 'rollback', 'create'));
-- the short-lived GitHub token parameter left in SSM for this run (deleted when the run finishes)
ALTER TABLE deployments ADD COLUMN token_param text;

CREATE TABLE app_creations (
    id             serial PRIMARY KEY,
    deployment_id  integer REFERENCES deployments (id) ON DELETE SET NULL,
    instance_id    integer NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
    project        text NOT NULL,
    repo           text NOT NULL,
    branch         text NOT NULL,
    domain         text NOT NULL,
    with_db        boolean NOT NULL DEFAULT false,
    port           integer,
    tls            boolean,
    status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
    created_by     text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz
);
-- one creation per project name per instance at a time
CREATE UNIQUE INDEX app_creations_one_running ON app_creations (instance_id, project) WHERE status = 'running';
