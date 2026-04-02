-- Daily Listing Sync: pg_cron job to trigger sp-api-sync every day at 6am ET
-- 6am EDT = 10:00 UTC (April-November), 6am EST = 11:00 UTC (November-April)
-- Using 10:00 UTC for EDT. Adjust to '0 11 * * *' during EST if needed.
--
-- Also includes a one-time startup sync that fires within 1 minute of migration
-- to seed initial listings without waiting until 6am.

-- 1. Schedule daily listing sync at 6am ET (10:00 UTC)
SELECT cron.schedule(
  'daily-listing-sync',
  '0 10 * * *',
  $$
  DO $do$
  DECLARE
    v_url TEXT;
    v_key TEXT;
    v_job_id UUID;
  BEGIN
    SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'supabase_url';
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

    -- Create a sync_status row for tracking
    INSERT INTO sync_status (status) VALUES ('running') RETURNING id INTO v_job_id;

    -- Trigger the sp-api-sync edge function
    PERFORM extensions.http((
      'POST',
      v_url || '/functions/v1/sp-api-sync',
      ARRAY[
        extensions.http_header('Content-Type', 'application/json'),
        extensions.http_header('Authorization', 'Bearer ' || v_key)
      ],
      'application/json',
      '{"jobId":"' || v_job_id::text || '"}'
    )::extensions.http_request);
  END $do$;
  $$
);

-- 2. One-time startup sync — runs at next minute, then unschedules itself
SELECT cron.schedule(
  'initial-listing-sync',
  '* * * * *',
  $$
  DO $do$
  DECLARE
    v_url TEXT;
    v_key TEXT;
    v_job_id UUID;
    v_count INTEGER;
  BEGIN
    -- Only run if listings table is empty or has no active listings
    SELECT count(*) INTO v_count FROM listings WHERE status = 'active';
    IF v_count > 0 THEN
      -- Already have listings, just unschedule and exit
      PERFORM cron.unschedule('initial-listing-sync');
      RETURN;
    END IF;

    SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'supabase_url';
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

    INSERT INTO sync_status (status) VALUES ('running') RETURNING id INTO v_job_id;

    PERFORM extensions.http((
      'POST',
      v_url || '/functions/v1/sp-api-sync',
      ARRAY[
        extensions.http_header('Content-Type', 'application/json'),
        extensions.http_header('Authorization', 'Bearer ' || v_key)
      ],
      'application/json',
      '{"jobId":"' || v_job_id::text || '"}'
    )::extensions.http_request);

    -- Unschedule this one-time job
    PERFORM cron.unschedule('initial-listing-sync');
  END $do$;
  $$
);
