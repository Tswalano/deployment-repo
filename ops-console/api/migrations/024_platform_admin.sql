-- Ops Console schema: platform owner portal.
--   suspended_*  : the platform suspended the workspace (read-only, like a lapsed subscription; servers keep running)
--   complimentary: a plan given by the platform without payment, optionally until comp_until
ALTER TABLE workspaces
    ADD COLUMN suspended_at     timestamptz,
    ADD COLUMN suspended_reason text,
    ADD COLUMN complimentary    boolean NOT NULL DEFAULT false,
    ADD COLUMN comp_until       timestamptz;
