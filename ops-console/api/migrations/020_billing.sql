-- Ops Console schema, Phase 12c: subscriptions with Paystack (multi-customer mode).
ALTER TABLE workspaces
    ADD COLUMN billing_status      text NOT NULL DEFAULT 'trialing'
        CHECK (billing_status IN ('trialing', 'active', 'past_due', 'cancelling', 'cancelled', 'expired')),
    ADD COLUMN paystack_customer   text,
    ADD COLUMN subscription_code   text,
    ADD COLUMN subscription_token  text,
    ADD COLUMN current_period_end  timestamptz,
    ADD COLUMN grace_until         timestamptz,
    ADD COLUMN billing_email       text;
-- the original single-team workspace is the platform's own: never billed
UPDATE workspaces SET billing_status = 'active' WHERE plan = 'internal';

-- Settings of the platform itself (not of any workspace): e.g. the Paystack plan codes.
CREATE TABLE platform_settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Paystack events, each handled once (the webhook may deliver the same event more than once).
CREATE TABLE billing_events (
    id           text PRIMARY KEY,
    workspace_id integer REFERENCES workspaces(id) ON DELETE SET NULL,
    event        text NOT NULL,
    summary      jsonb NOT NULL DEFAULT '{}',
    at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_events_workspace ON billing_events (workspace_id, at DESC);
