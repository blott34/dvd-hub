-- Auto Reprice: reprice_runs table, auto_reprice_enabled setting, pg_cron schedule
-- This migration sets up automatic repricing infrastructure.

-- 1. Create reprice_runs table to log every automatic reprice run
CREATE TABLE IF NOT EXISTS reprice_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  listings_checked INTEGER DEFAULT 0,
  prices_changed INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  error_message TEXT
);

ALTER TABLE reprice_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on reprice_runs" ON reprice_runs FOR ALL USING (true) WITH CHECK (true);

-- 2. Create auto_reprice_settings table for the toggle
CREATE TABLE IF NOT EXISTS auto_reprice_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton row
  enabled BOOLEAN NOT NULL DEFAULT true,
  interval_minutes INTEGER NOT NULL DEFAULT 15,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE auto_reprice_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on auto_reprice_settings" ON auto_reprice_settings FOR ALL USING (true) WITH CHECK (true);

-- Insert default settings (enabled, 15 min interval)
INSERT INTO auto_reprice_settings (id, enabled, interval_minutes)
VALUES (1, true, 15)
ON CONFLICT (id) DO NOTHING;

-- 3. Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;

-- 4. Create pg_cron job that calls the sp-api-reprice edge function every 15 minutes
-- The edge function URL uses the Supabase project URL pattern.
-- The function itself checks auto_reprice_settings.enabled before running.
SELECT cron.schedule(
  'auto-reprice-every-15min',
  '*/15 * * * *',
  $$
  SELECT extensions.http((
    'POST',
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/sp-api-reprice',
    ARRAY[
      extensions.http_header('Content-Type', 'application/json'),
      extensions.http_header('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'))
    ],
    'application/json',
    '{"source":"pg_cron"}'
  )::extensions.http_request);
  $$
);
