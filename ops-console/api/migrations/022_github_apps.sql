-- Ops Console schema: each workspace's own private GitHub App (multi-customer mode), created from a manifest in one
-- click. Credentials stay in SSM (/ops-console/github/ws/<workspace>/app); this table only maps the app's id to its
-- workspace, so a webhook delivery can be routed (and its signature checked) with the right workspace's secret.
CREATE TABLE github_apps (
    workspace_id integer PRIMARY KEY DEFAULT current_workspace() REFERENCES workspaces(id) ON DELETE CASCADE,
    app_id       bigint NOT NULL UNIQUE,
    slug         text NOT NULL,
    owner        text NOT NULL,
    created_by   text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE github_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_apps FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON github_apps
    USING (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace())
    WITH CHECK (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace());
