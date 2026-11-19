-- Ops Console schema: "Ask Ops Console" with the workspace's own AI provider key (Anthropic Claude or OpenAI).
-- A conversation is kept in the format of the provider that wrote it, so it records which one; switching provider
-- starts a new conversation. (The key itself is stored in the workspace's own AWS account, never in this database.)
ALTER TABLE assistant_conversations ADD COLUMN provider text NOT NULL DEFAULT 'anthropic' CHECK (provider IN ('anthropic', 'openai'));
