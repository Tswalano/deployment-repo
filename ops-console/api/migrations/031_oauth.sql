-- Ops Console schema: OAuth 2.1 sign-in for the workspace MCP server, so connectors such as ChatGPT and claude.ai
-- can connect after the person approves them (MCP authorization: PKCE, dynamic client registration, refresh tokens).
-- Clients and authorisation codes are not workspace data (a client is registered before anyone signs in); they are
-- only read and written by the console itself.
CREATE TABLE oauth_clients (
    client_id          text PRIMARY KEY,
    client_secret_hash text,                    -- NULL: a public client (PKCE only)
    client_name        text NOT NULL,
    client_uri         text,
    redirect_uris      text[] NOT NULL,
    auth_method        text NOT NULL DEFAULT 'none' CHECK (auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    created_ip         text,
    last_used_at       timestamptz
);

CREATE TABLE oauth_codes (
    code_hash       text PRIMARY KEY,
    client_id       text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id         integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id    integer NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    redirect_uri    text NOT NULL,
    code_challenge  text NOT NULL,
    scope           text NOT NULL,
    resource        text NOT NULL,
    expires_at      timestamptz NOT NULL,
    used_at         timestamptz
);

-- an OAuth grant is a token row too: short-lived access token (token_hash/expires_at) plus a rotating refresh token
ALTER TABLE mcp_tokens
    ADD COLUMN kind text NOT NULL DEFAULT 'pat' CHECK (kind IN ('pat', 'oauth')),
    ADD COLUMN client_id text REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    ADD COLUMN refresh_hash text UNIQUE,
    ADD COLUMN prev_refresh_hash text,
    ADD COLUMN refresh_expires_at timestamptz;
CREATE INDEX mcp_tokens_prev_refresh ON mcp_tokens (prev_refresh_hash) WHERE prev_refresh_hash IS NOT NULL;
