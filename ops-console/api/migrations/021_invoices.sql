-- Ops Console schema, Phase 12c: invoices, one per successful Paystack payment (multi-customer mode).
CREATE SEQUENCE invoice_number_seq;
CREATE TABLE invoices (
    id            serial PRIMARY KEY,
    workspace_id  integer NOT NULL DEFAULT current_workspace() REFERENCES workspaces(id) ON DELETE CASCADE,
    number        text NOT NULL UNIQUE,
    reference     text NOT NULL UNIQUE,          -- Paystack transaction reference (one invoice per payment)
    issued_at     timestamptz NOT NULL,
    plan          text NOT NULL,
    description   text NOT NULL,
    amount        integer NOT NULL,              -- cents
    currency      text NOT NULL DEFAULT 'ZAR',
    period_start  date,
    period_end    date,
    billed_to     text NOT NULL,                 -- workspace name at the time
    billed_email  text,
    card          text,                          -- e.g. "Visa •••• 4081"
    status        text NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'refunded'))
);
CREATE INDEX invoices_workspace ON invoices (workspace_id, issued_at DESC);
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON invoices
    USING (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace())
    WITH CHECK (current_setting('app.bypass', true) = 'on' OR workspace_id = current_workspace());
