-- Ops Console schema: server components (PostgreSQL, MariaDB, Valkey, SQLite, Python, ...). Installing, starting,
-- stopping or removing one is a background job tracked like a deploy (one job per server at a time); the server's
-- last inventory is kept with the instance.
ALTER TABLE deployments DROP CONSTRAINT deployments_action_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_action_check CHECK (action IN ('deploy', 'rollback', 'create', 'prepare', 'component'));
ALTER TABLE instances ADD COLUMN components jsonb, ADD COLUMN components_at timestamptz;
