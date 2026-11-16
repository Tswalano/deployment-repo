-- Ops Console schema, Phase 8: EC2 power state (so a stopped instance reads "stopped", not "unreachable").
ALTER TABLE instances
    ADD COLUMN ec2_state     text,
    ADD COLUMN ec2_state_at  timestamptz;
