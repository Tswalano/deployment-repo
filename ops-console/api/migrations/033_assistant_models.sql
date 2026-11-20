-- Ops Console schema: several models can be set up for Ask Ops Console (one API key per provider, models chosen by
-- admins, one default). A conversation remembers the model it was started with.
ALTER TABLE assistant_conversations ADD COLUMN model text;
