-- Ops Console schema, Phase 12b-3: which GitHub App installations belong to which workspace (multi-customer mode).
-- Linked only after GitHub confirms the person installing can access the installation (OAuth during install).
CREATE TABLE github_installations (
    workspace_id    integer NOT NULL DEFAULT current_workspace() REFERENCES workspaces(id) ON DELETE CASCADE,
    installation_id bigint NOT NULL,
    account_login   text NOT NULL,
    account_type    text,
    linked_by       text NOT NULL,
    linked_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, installation_id)
);
CREATE INDEX github_installations_installation ON github_installations (installation_id);
ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON github_installations
    USING (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace())
    WITH CHECK (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace());
