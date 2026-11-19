-- Ops Console schema: personal access tokens for the workspace MCP endpoint (/mcp), so AI tools such as Claude
-- Desktop, Claude Code or ChatGPT can read the workspace with their owner's access. Only a SHA-256 of each token
-- is kept; the token itself is shown once when it is created.
CREATE TABLE mcp_tokens (
    id            serial PRIMARY KEY,
    workspace_id  integer NOT NULL DEFAULT current_workspace() REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          text NOT NULL,
    token_hash    text NOT NULL UNIQUE,
    prefix        text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz,
    last_used_at  timestamptz,
    last_used_ip  text,
    revoked_at    timestamptz
);
CREATE INDEX mcp_tokens_user ON mcp_tokens (workspace_id, user_id);
ALTER TABLE mcp_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON mcp_tokens
    USING (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace())
    WITH CHECK (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace());
