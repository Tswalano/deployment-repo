-- Ops Console schema, Phase 7: deploy approvals and freeze windows.
ALTER TABLE deployments DROP CONSTRAINT deployments_status_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
    CHECK (status IN ('pending_approval', 'running', 'success', 'failed', 'rejected', 'expired', 'cancelled'));
ALTER TABLE deployments
    ADD COLUMN approved_by      text,
    ADD COLUMN approved_at      timestamptz,
    ADD COLUMN decision_reason  text,          -- why it was rejected or cancelled
    ADD COLUMN override_reason  text,          -- admin break-glass: freeze and/or approval skipped
    ADD COLUMN expires_at       timestamptz;   -- pending requests lapse after this
-- one open request per app; running deployments are still limited to one per instance
CREATE UNIQUE INDEX deployments_one_pending ON deployments (instance_id, project) WHERE status = 'pending_approval';
