-- Ops Console schema: failed deployments someone has looked at and dismissed (hidden from the list, alert cleared).
-- kind 'deploy': a failed/rolled-back deploy event (instance, project, event time from the pipeline history).
-- kind 'create': a failed new-app creation (app_creations.id).
CREATE TABLE dismissed_failures (
    id            serial PRIMARY KEY,
    workspace_id  integer NOT NULL DEFAULT current_workspace() REFERENCES workspaces(id) ON DELETE CASCADE,
    instance_id   integer NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
    project       text NOT NULL,
    kind          text NOT NULL CHECK (kind IN ('deploy', 'create')),
    event_at      timestamptz,
    creation_id   integer REFERENCES app_creations(id) ON DELETE CASCADE,
    note          text,
    dismissed_by  text NOT NULL,
    dismissed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dismissed_failures_deploy ON dismissed_failures (instance_id, project, event_at) WHERE kind = 'deploy';
CREATE UNIQUE INDEX dismissed_failures_create ON dismissed_failures (creation_id) WHERE kind = 'create';
CREATE INDEX dismissed_failures_workspace ON dismissed_failures (workspace_id);
ALTER TABLE dismissed_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE dismissed_failures FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON dismissed_failures
    USING (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace())
    WITH CHECK (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace());
