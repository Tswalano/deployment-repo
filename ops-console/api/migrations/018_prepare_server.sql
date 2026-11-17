-- Ops Console schema, Phase 12b-2: "prepare server" runs are tracked like deploys (one at a time per instance).
ALTER TABLE deployments DROP CONSTRAINT deployments_action_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_action_check CHECK (action IN ('deploy', 'rollback', 'create', 'prepare'));
