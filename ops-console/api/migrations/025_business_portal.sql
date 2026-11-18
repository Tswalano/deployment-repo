-- Ops Console schema: business side of the platform portal.

-- Platform access is an explicit flag (not "any admin of the platform's workspace"): inviting someone to that
-- workspace never gives them the portal. The current admins of the internal workspace keep it.
ALTER TABLE users ADD COLUMN platform_admin boolean NOT NULL DEFAULT false;
UPDATE users u SET platform_admin = true
  FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
 WHERE m.user_id = u.id AND m.role = 'admin' AND w.plan = 'internal' AND NOT u.is_demo;

ALTER TABLE workspaces
    -- limits above the plan, set by the platform: {"servers": 8, "apps": 30, "members": 15, "until": "2027-01-31T..."}
    ADD COLUMN limit_overrides        jsonb,
    -- renewals run by the console: Paystack keeps the card, the console charges it each period (credits first)
    ADD COLUMN paystack_authorization text,
    ADD COLUMN card_label             text,
    ADD COLUMN last_charge_at         timestamptz,
    ADD COLUMN last_charge_error      text,
    ADD COLUMN next_retry_at          timestamptz,
    ADD COLUMN charge_reference       text;

-- Credits in cents: granted by the platform (+), unused time when switching plans (+), a card check (+),
-- used at a renewal (-). The balance is the sum. One row per reference, so a payment is never counted twice.
CREATE TABLE billing_credits (
    id           serial PRIMARY KEY,
    workspace_id integer NOT NULL DEFAULT current_workspace() REFERENCES workspaces(id) ON DELETE CASCADE,
    amount       integer NOT NULL,
    kind         text NOT NULL CHECK (kind IN ('grant', 'renewal', 'proration', 'card_check', 'adjust')),
    note         text,
    reference    text UNIQUE,
    created_by   text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_credits_workspace ON billing_credits (workspace_id, created_at DESC);
ALTER TABLE billing_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_credits FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON billing_credits
    USING (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace())
    WITH CHECK (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace());

-- an invoice can be paid partly (or fully) with credit
ALTER TABLE invoices ADD COLUMN credit_applied integer NOT NULL DEFAULT 0;
