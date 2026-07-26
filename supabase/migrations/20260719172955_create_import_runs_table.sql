-- import_runs: tracks each importer execution and prevents overlapping runs.
-- One 'running' row per cinema at a time, enforced by a partial unique index.
-- Only the service role (edge functions) accesses this table; no public RLS policies.
CREATE TABLE IF NOT EXISTS import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cinema_name text NOT NULL,
  status text NOT NULL, -- 'running' | 'success' | 'failed'
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  screenings_found integer,
  screenings_saved integer,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Only one running import per cinema at a time.
CREATE UNIQUE INDEX IF NOT EXISTS import_runs_one_running_per_cinema
  ON import_runs (cinema_name) WHERE status = 'running';

ALTER TABLE import_runs ENABLE ROW LEVEL SECURITY;
-- No SELECT/INSERT/UPDATE policies: only the service role key (which bypasses
-- RLS) used by edge functions can access this table.
