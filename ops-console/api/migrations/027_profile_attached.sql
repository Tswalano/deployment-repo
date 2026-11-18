-- Ops Console schema: when the console gave an already-running server its instance profile. The Session Manager agent
-- only picks up a profile added after boot on its slow retry schedule (up to ~30 minutes); a reboot connects it at once.
-- The console uses this to say "Reboot the server once to connect it" instead of a generic "not reachable".
ALTER TABLE instances ADD COLUMN profile_attached_at timestamptz;
