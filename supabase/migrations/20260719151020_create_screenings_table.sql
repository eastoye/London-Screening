/*
# Create screenings table for cinema imports

1. New Tables
- `screenings`
  - `id` (uuid, primary key)
  - `cinema_name` (text, not null) — e.g. "Prince Charles Cinema"
  - `movie_title` (text, not null) — film title
  - `start_time` (timestamptz, not null) — screening start in Europe/London
  - `booking_url` (text, nullable) — deep link to book this performance
  - `format` (text, nullable) — joined modifiers e.g. "35mm, 4K, SUB"
  - `sold_out` (boolean, default false) — whether the screening is sold out
  - `source_reference` (text, unique not null) — stable id e.g. "pcc:31627072"
  - `last_seen_at` (timestamptz, not null default now()) — last import that observed this screening
  - `active` (boolean, default true) — false once screening is missing from a successful import or has passed
  - `created_at` (timestamptz, default now())
  - `updated_at` (timestamptz, default now())
2. Indexes
- Unique index on `source_reference` to support upsert conflict target.
- Index on `cinema_name` + `start_time` for listing upcoming screenings.
3. Security
- Enable RLS on `screenings`.
- Single-tenant / no-auth app: the data is intentionally public screening information.
  Allow anon + authenticated full CRUD so the anon-key frontend can read and the
  edge function (service role, bypasses RLS) can write.
*/

CREATE TABLE IF NOT EXISTS screenings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cinema_name text NOT NULL,
  movie_title text NOT NULL,
  start_time timestamptz NOT NULL,
  booking_url text,
  format text,
  sold_out boolean NOT NULL DEFAULT false,
  source_reference text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS screenings_source_reference_key
  ON screenings (source_reference);

CREATE INDEX IF NOT EXISTS screenings_cinema_start_idx
  ON screenings (cinema_name, start_time);

ALTER TABLE screenings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_screenings" ON screenings;
CREATE POLICY "anon_select_screenings" ON screenings FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_screenings" ON screenings;
CREATE POLICY "anon_insert_screenings" ON screenings FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_screenings" ON screenings;
CREATE POLICY "anon_update_screenings" ON screenings FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_screenings" ON screenings;
CREATE POLICY "anon_delete_screenings" ON screenings FOR DELETE
  TO anon, authenticated USING (true);
