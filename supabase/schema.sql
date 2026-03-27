-- DVD Hub Database Schema
-- Run this in the Supabase SQL Editor to set up all tables

-- Daily scan log (Pass/Fail entries)
CREATE TABLE daily_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  employee TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('Pass', 'Fail'))
);

-- Shipments completed by scanner
CREATE TABLE shipments_completed (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  employee TEXT NOT NULL,
  shipment_number INT NOT NULL,
  units INT NOT NULL DEFAULT 100,
  placement_fee NUMERIC(10,2) NOT NULL DEFAULT 16.00,
  shipping_fee NUMERIC(10,2) NOT NULL DEFAULT 11.50,
  total_cost NUMERIC(10,2) NOT NULL
);

-- Batches marked ready by cleaner
CREATE TABLE shipments_ready (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  employee TEXT NOT NULL,
  quantity INT NOT NULL DEFAULT 100,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'READY' CHECK (status IN ('READY', 'COMPLETED')),
  skus_listed INT
);

-- Employee time punches
CREATE TABLE timesheet (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  employee TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('IN', 'OUT')),
  time_in TIMESTAMPTZ,
  time_out TIMESTAMPTZ,
  hours_worked NUMERIC(5,2)
);

-- Supply inventory tracker
CREATE TABLE supply_tracker (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item TEXT NOT NULL,
  current_stock INT NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'units',
  order_trigger INT NOT NULL DEFAULT 5,
  reorder_qty INT NOT NULL DEFAULT 20,
  status TEXT NOT NULL DEFAULT 'In Stock'
);

-- Daily summary (populated by nightly job)
CREATE TABLE daily_summary (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date DATE NOT NULL UNIQUE DEFAULT CURRENT_DATE,
  total_scans INT NOT NULL DEFAULT 0,
  passes INT NOT NULL DEFAULT 0,
  fails INT NOT NULL DEFAULT 0,
  pass_rate NUMERIC(5,2),
  shipments_completed INT NOT NULL DEFAULT 0,
  batches_ready INT NOT NULL DEFAULT 0
);

-- Seed supply items
INSERT INTO supply_tracker (item, current_stock, unit, order_trigger, reorder_qty, status) VALUES
  ('Poly sleeves', 500, 'sleeves', 100, 500, 'In Stock'),
  ('Shrink wrap rolls', 8, 'rolls', 3, 10, 'In Stock'),
  ('Boxes (100 count)', 15, 'boxes', 5, 20, 'In Stock'),
  ('Tape rolls', 12, 'rolls', 4, 12, 'In Stock'),
  ('Labels', 300, 'labels', 50, 200, 'In Stock'),
  ('Bubble wrap', 6, 'rolls', 2, 8, 'In Stock'),
  ('Markers', 10, 'markers', 3, 10, 'In Stock'),
  ('Cleaning solution', 4, 'bottles', 2, 6, 'In Stock'),
  ('Reseal bags', 200, 'bags', 50, 200, 'In Stock');

-- Enable Row Level Security (allow all for now since no auth)
ALTER TABLE daily_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments_completed ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments_ready ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet ENABLE ROW LEVEL SECURITY;
ALTER TABLE supply_tracker ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_summary ENABLE ROW LEVEL SECURITY;

-- Permissive policies (no auth, employee-based only)
CREATE POLICY "Allow all" ON daily_log FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON shipments_completed FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON shipments_ready FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON timesheet FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON supply_tracker FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON daily_summary FOR ALL USING (true) WITH CHECK (true);

-- Nightly summary function (call via Supabase cron or pg_cron)
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
  SELECT COUNT(*) INTO scan_count FROM daily_log
    WHERE timestamp::date = today;

  SELECT COUNT(*) INTO pass_count FROM daily_log
    WHERE timestamp::date = today AND result = 'Pass';

  SELECT COUNT(*) INTO fail_count FROM daily_log
    WHERE timestamp::date = today AND result = 'Fail';

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

-- To set up nightly cron (run in SQL editor after enabling pg_cron extension):
-- SELECT cron.schedule('nightly-summary', '0 0 * * *', 'SELECT generate_daily_summary()');
