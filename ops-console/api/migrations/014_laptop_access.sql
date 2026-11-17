-- Ops Console schema, Phase 11: SSH from your own laptop.

-- Public keys people saved in the console (never private keys).
CREATE TABLE user_ssh_keys (
    id           serial PRIMARY KEY,
    user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         text NOT NULL,
    public_key   text NOT NULL,
    fingerprint  text NOT NULL,
    key_type     text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    UNIQUE (user_id, fingerprint)
);

-- A grant can also be a temporary key (laptop access): from=/expiry-time= restricted, removed again on expiry.
ALTER TABLE ssh_grants ALTER COLUMN group_id DROP NOT NULL;
ALTER TABLE ssh_grants ALTER COLUMN cidr DROP NOT NULL;
ALTER TABLE ssh_grants
    ADD COLUMN kind            text NOT NULL DEFAULT 'ip' CHECK (kind IN ('ip', 'key')),
    ADD COLUMN route           text CHECK (route IN ('direct', 'ssm')),
    ADD COLUMN key_user        text,
    ADD COLUMN key_fingerprint text,
    ADD COLUMN key_from        text,
    ADD COLUMN key_added       boolean NOT NULL DEFAULT false,
    ADD COLUMN user_key_id     integer REFERENCES user_ssh_keys(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX ssh_grants_open_key ON ssh_grants (instance_id, key_user, key_fingerprint) WHERE revoked_at IS NULL AND kind = 'key';
