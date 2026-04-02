-- Add live_mode column to auto_reprice_settings.
-- When false (default), the repricer runs in simulation mode:
--   fetches Buy Box, runs rules, logs decisions, but does NOT push prices to Amazon.
-- When true, the repricer pushes real price changes.

ALTER TABLE auto_reprice_settings ADD COLUMN IF NOT EXISTS live_mode BOOLEAN NOT NULL DEFAULT false;
