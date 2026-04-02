-- Sync Poller: pg_cron job that runs every 2 minutes.
-- Checks if there's a running sync job and calls sp-api-sync to advance it (Phase 2).
-- This completes the two-phase sync: Phase 1 requests the report, Phase 2 processes it.

SELECT cron.schedule(
  'sync-poller',
  '*/2 * * * *',
  $$
  DO $do$
  DECLARE
    v_url TEXT;
    v_key TEXT;
    v_job_id UUID;
  BEGIN
    -- Find the most recent running sync job
    SELECT id INTO v_job_id FROM sync_status
      WHERE status = 'running'
      ORDER BY started_at DESC
      LIMIT 1;

    -- No running job — nothing to do
    IF v_job_id IS NULL THEN
      RETURN;
    END IF;

    SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'supabase_url';
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

    -- Call sp-api-sync with the running job ID to advance it
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
