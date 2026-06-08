-- Keepa Auto-Verdict Scanner — Phase 1: scan_logs table
-- Run this in the Supabase SQL Editor against project lfwrlwetayyqcfyggmfi

-- 1. Create scan_logs table
CREATE TABLE public.scan_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  employee TEXT NOT NULL,
  upc TEXT,
  keepa_asin TEXT,
  keepa_candidate_asins JSONB,
  keepa_snapshot JSONB,
  automated_verdict TEXT CHECK (automated_verdict IN ('pass','fail','error')),
  automated_rule_triggered TEXT,
  manual_verdict TEXT CHECK (manual_verdict IN ('pass','fail')),
  verdict_agreement BOOLEAN GENERATED ALWAYS AS (
    CASE
      WHEN automated_verdict IS NULL OR manual_verdict IS NULL THEN NULL
      WHEN automated_verdict = manual_verdict THEN TRUE
      ELSE FALSE
    END
  ) STORED,
  keepa_tokens_left INTEGER,
  keepa_lookup_ms INTEGER
);

-- 2. Backfill existing daily_log rows
INSERT INTO public.scan_logs (created_at, employee, manual_verdict)
SELECT
  timestamp,
  employee,
  LOWER(result)
FROM public.daily_log;

-- 3. Indexes
CREATE INDEX scan_logs_created_at_idx
  ON public.scan_logs (created_at);

CREATE INDEX scan_logs_employee_created_at_idx
  ON public.scan_logs (employee, created_at);

CREATE INDEX scan_logs_verdict_agreement_idx
  ON public.scan_logs (verdict_agreement)
  WHERE verdict_agreement IS NOT NULL;

CREATE INDEX scan_logs_automated_rule_idx
  ON public.scan_logs (automated_rule_triggered);

-- 4. Row Level Security
ALTER TABLE public.scan_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON public.scan_logs FOR ALL USING (true) WITH CHECK (true);

-- 5. Updated generate_daily_summary — now reads from scan_logs
CREATE OR REPLACE FUNCTION generate_daily_summary()
RETURNS void AS $$
DECLARE
  today DATE := CURRENT_DATE - INTERVAL '1 day';
  scan_count INT;
  pass_count INT;
  fail_count INT;
  ship_count INT;
  batch_count INT;
BEGIN
  SELECT COUNT(*) INTO scan_count FROM public.scan_logs
    WHERE created_at::date = today;

  SELECT COUNT(*) INTO pass_count FROM public.scan_logs
    WHERE created_at::date = today
      AND COALESCE(manual_verdict, automated_verdict) = 'pass';

  SELECT COUNT(*) INTO fail_count FROM public.scan_logs
    WHERE created_at::date = today
      AND COALESCE(manual_verdict, automated_verdict) = 'fail';

  SELECT COUNT(*) INTO ship_count FROM shipments_completed
    WHERE date = today;

  SELECT COUNT(*) INTO batch_count FROM shipments_ready
    WHERE timestamp::date = today;

  INSERT INTO daily_summary (date, total_scans, passes, fails, pass_rate, shipments_completed, batches_ready)
  VALUES (
    today,
    scan_count,
    pass_count,
    fail_count,
    CASE WHEN scan_count > 0 THEN ROUND((pass_count::numeric / scan_count) * 100, 2) ELSE 0 END,
    ship_count,
    batch_count
  )
  ON CONFLICT (date) DO UPDATE SET
    total_scans = EXCLUDED.total_scans,
    passes = EXCLUDED.passes,
    fails = EXCLUDED.fails,
    pass_rate = EXCLUDED.pass_rate,
    shipments_completed = EXCLUDED.shipments_completed,
    batches_ready = EXCLUDED.batches_ready;
END;
$$ LANGUAGE plpgsql;
