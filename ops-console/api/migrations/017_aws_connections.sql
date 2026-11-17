-- Ops Console schema, Phase 12b: a workspace's own AWS account (multi-customer mode).
-- The console reaches it only by assuming the role the customer created with our CloudFormation template; the role
-- trusts the console only when this workspace's external ID is presented (confused-deputy protection).
CREATE TABLE aws_connections (
    workspace_id   integer PRIMARY KEY DEFAULT current_workspace() REFERENCES workspaces(id) ON DELETE CASCADE,
    external_id    text NOT NULL UNIQUE CHECK (external_id ~ '^[A-Za-z0-9-]{32,64}$'),
    region         text NOT NULL DEFAULT 'af-south-1',
    role_arn       text,
    account_id     text,
    status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'error', 'disconnected')),
    error          text,
    connected_by   text,
    connected_at   timestamptz,
    checked_at     timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE aws_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE aws_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON aws_connections
    USING (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace())
    WITH CHECK (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace());
