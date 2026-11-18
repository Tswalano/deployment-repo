-- Ops Console schema: every email the console sends (account emails, invitations, alerts), sent or refused, so the
-- platform owner can see what went out (Platform admin -> Console health). Platform-level: read only by the portal.
CREATE TABLE email_log (
    id           bigserial PRIMARY KEY,
    workspace_id integer REFERENCES workspaces(id) ON DELETE SET NULL,
    kind         text NOT NULL,              -- verify_email | reset_password | invite | alert | test
    recipients   text NOT NULL,
    subject      text NOT NULL,
    ok           boolean NOT NULL,
    error        text,
    at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_log_at ON email_log (at DESC);
