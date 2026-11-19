-- Ops Console schema: actions proposed by the assistant or an MCP client (deploy, roll back, start or reboot a
-- server). A proposal does nothing by itself: the person it was proposed to confirms it in the console, and it then
-- runs through the same code, role checks, deploy policy (approvals, freeze windows) and audit log as the buttons.
CREATE TABLE assistant_actions (
    id               text PRIMARY KEY,
    workspace_id     integer NOT NULL DEFAULT current_workspace() REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id          integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source           text NOT NULL CHECK (source IN ('chat', 'mcp')),
    via              text NOT NULL,
    conversation_id  text REFERENCES assistant_conversations(id) ON DELETE SET NULL,
    kind             text NOT NULL CHECK (kind IN ('deploy', 'rollback', 'start', 'reboot')),
    instance_id      integer NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
    project          text,
    ref              text NOT NULL DEFAULT '',
    summary          text NOT NULL,
    note             text,
    status           text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'running', 'done', 'failed', 'cancelled')),
    result           jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
    decided_at       timestamptz
);
CREATE INDEX assistant_actions_user ON assistant_actions (workspace_id, user_id, created_at DESC);
CREATE INDEX assistant_actions_conv ON assistant_actions (conversation_id) WHERE conversation_id IS NOT NULL;
ALTER TABLE assistant_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON assistant_actions
    USING (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace())
    WITH CHECK (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace());
