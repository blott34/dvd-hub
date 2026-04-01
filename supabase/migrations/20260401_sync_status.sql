-- Sync status tracking table for async Amazon listing sync jobs
CREATE TABLE sync_status (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  total_raw INTEGER DEFAULT 0,
  listings_synced INTEGER DEFAULT 0,
  prices_fetched INTEGER DEFAULT 0,
  ranks_fetched INTEGER DEFAULT 0,
  error_message TEXT,
  log TEXT DEFAULT ''
);

CREATE INDEX idx_sync_status_started ON sync_status(started_at DESC);
