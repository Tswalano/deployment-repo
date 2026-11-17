-- Ops Console schema, Phase 10a: GitHub App connection, repos linked to apps, webhook deliveries.
CREATE TABLE app_repos (
    id            serial PRIMARY KEY,
    instance_id   integer NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
    project       text NOT NULL,
    repo          text NOT NULL,                 -- owner/name
    branch        text NOT NULL DEFAULT 'main',
    auto_deploy   boolean NOT NULL DEFAULT false,
    linked_by     text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (instance_id, project)
);
CREATE INDEX app_repos_by_repo ON app_repos (repo, branch);

CREATE TABLE github_deliveries (
    id          text PRIMARY KEY,                -- X-GitHub-Delivery (idempotency)
    event       text NOT NULL,
    repo        text,
    ref         text,
    sha         text,
    result      text NOT NULL,
    at          timestamptz NOT NULL DEFAULT now()
);

-- Deployments started by GitHub pushes have no console user.
ALTER TABLE deployments ADD COLUMN trigger text NOT NULL DEFAULT 'console';
