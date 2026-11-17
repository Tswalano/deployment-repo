-- Ops Console schema: remember whether the console created an app's DNS record, so a failed creation can remove it.
ALTER TABLE app_creations ADD COLUMN dns_created boolean NOT NULL DEFAULT false;
