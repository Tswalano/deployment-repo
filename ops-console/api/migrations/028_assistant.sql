-- Ops Console schema: "Ask Ops Console", the in-app assistant (an LLM that answers questions about the workspace by
-- calling read-only tools). Conversations are kept so a chat survives a page reload and its history is sent back to
-- the model unchanged (append-only); usage is counted per workspace and month for the plan's question allowance.
CREATE TABLE assistant_conversations (
    id           text PRIMARY KEY,
    workspace_id integer NOT NULL DEFAULT current_workspace() REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title        text NOT NULL,
    messages     jsonb NOT NULL DEFAULT '[]',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_conversations_user ON assistant_conversations (workspace_id, user_id, updated_at DESC);
ALTER TABLE assistant_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON assistant_conversations
    USING (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace())
    WITH CHECK (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace());

CREATE TABLE assistant_usage (
    workspace_id  integer NOT NULL DEFAULT current_workspace() REFERENCES workspaces(id) ON DELETE CASCADE,
    month         date NOT NULL,
    questions     integer NOT NULL DEFAULT 0,
    input_tokens  bigint NOT NULL DEFAULT 0,
    cached_tokens bigint NOT NULL DEFAULT 0,
    output_tokens bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, month)
);
ALTER TABLE assistant_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON assistant_usage
    USING (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace())
    WITH CHECK (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace());
