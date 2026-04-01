-- Add no_buybox_raise_amount column and Match Buy Box rule

ALTER TABLE repricing_rules ADD COLUMN IF NOT EXISTS no_buybox_raise_amount NUMERIC(10,2);

INSERT INTO repricing_rules (rule_name, is_active, days_before_drop, drop_amount, max_hit_raise_amount, target_position, no_buybox_raise_amount, notes) VALUES
  ('Match Buy Box', true, NULL, NULL, NULL, NULL, 1.00, 'Match the Buy Box price within min/max bounds. If no Buy Box, raise price by configurable amount.')
ON CONFLICT (rule_name) DO NOTHING;
