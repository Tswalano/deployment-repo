-- Ops Console schema: where each new app's DNS record lives, so it can be cleaned up in the right place.
--   workspace: the workspace's own Route 53 zone (or APPS_DOMAIN in single-team mode)
--   platform:  the platform's zone (addresses like shop.<workspace>.<PLATFORM_APPS_DOMAIN>)
--   external:  DNS at another provider: the customer adds the record; nothing for the console to remove
ALTER TABLE app_creations ADD COLUMN dns_provider text CHECK (dns_provider IN ('workspace', 'platform', 'external'));
ALTER TABLE app_creations ADD COLUMN dns_zone text;
