-- Repricer tables for Amazon DVD repricing engine

CREATE TABLE listings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  asin TEXT NOT NULL,
  sku TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  current_price NUMERIC(10,2) NOT NULL,
  min_price NUMERIC(10,2) NOT NULL DEFAULT 8.50,
  max_price NUMERIC(10,2) NOT NULL DEFAULT 24.99,
  cost_basis NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  sales_rank INTEGER,
  date_listed DATE NOT NULL DEFAULT CURRENT_DATE,
  last_sold TIMESTAMPTZ,
  last_repriced TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'sold'))
);

CREATE TABLE repricing_rules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  rule_name TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  days_before_drop INTEGER,
  drop_amount NUMERIC(10,2),
  max_hit_raise_amount NUMERIC(10,2),
  target_position INTEGER,
  notes TEXT
);

CREATE TABLE repricing_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  asin TEXT NOT NULL,
  sku TEXT NOT NULL,
  old_price NUMERIC(10,2) NOT NULL,
  new_price NUMERIC(10,2) NOT NULL,
  reason TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for common queries
CREATE INDEX idx_listings_status ON listings(status);
CREATE INDEX idx_listings_asin ON listings(asin);
CREATE INDEX idx_repricing_log_timestamp ON repricing_log(timestamp DESC);

-- Seed repricing rules
INSERT INTO repricing_rules (rule_name, is_active, days_before_drop, drop_amount, max_hit_raise_amount, target_position, notes) VALUES
  ('Default Floors', true, NULL, NULL, NULL, NULL, 'Min $8.50, Max $24.99 for all listings unless overridden'),
  ('Max Hit Day 1', true, NULL, NULL, 3.00, NULL, 'If listing hits max price on day 1, raise max by configured amount'),
  ('Stale Inventory', true, 30, 0.50, NULL, NULL, 'Drop min price after configured days without a sale'),
  ('Never Below Cost', true, NULL, NULL, NULL, NULL, 'No rule can drop price below cost_basis'),
  ('Sales Rank Guard', true, NULL, NULL, NULL, 500000, 'Do not reprice downward if sales rank above threshold');
