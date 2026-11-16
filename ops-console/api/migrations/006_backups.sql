-- Ops Console schema, Phase 6: restore tests of database backups.
CREATE TABLE backup_verifications (
    id           serial PRIMARY KEY,
    instance_id  integer NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
    db           text NOT NULL,
    file         text NOT NULL,
    ok           boolean NOT NULL,
    tables       integer,
    rows         bigint,
    live_tables  integer,
    live_rows    bigint,
    seconds      integer,
    error        text,
    trigger      text NOT NULL CHECK (trigger IN ('auto', 'manual')),
    requested_by text,
    at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX backup_verifications_lookup ON backup_verifications (instance_id, db, at DESC);
