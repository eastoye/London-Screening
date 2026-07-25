/*
# Create movies table and link screenings to movies

1. New Tables
- `movies`
  - `id` (uuid, primary key)
  - `normalised_title` (text, not null) — cinema-specific text stripped, used for dedup
  - `display_title` (text, not null) — the cleaned title shown to users
  - `release_year` (integer, nullable) — TMDB release year when known
  - `tmdb_id` (bigint, unique, nullable) — TMDB movie id
  - `poster_path` (text, nullable) — TMDB poster_path (e.g. "/abc.jpg")
  - `match_status` (text, not null default 'pending') — one of:
      pending | matched | needs_review | unmatched
  - `match_confidence` (numeric, nullable) — 0..1 confidence of the TMDB match
  - `created_at` (timestamptz, default now())
  - `updated_at` (timestamptz, default now())
2. Modified Tables
- `screenings`: add `movie_id` (uuid, nullable) referencing `movies.id`
  with ON DELETE SET NULL. Backfilled by the match-movie-posters edge function.
3. Indexes
- Unique index on `movies.normalised_title` so the matcher can upsert/lookup
  by normalised title without duplicating movies.
- Index on `screenings.movie_id` for the join.
4. Security
- Enable RLS on `movies`.
- Public read-only: anon + authenticated can SELECT (the homepage needs posters).
  No public INSERT/UPDATE/DELETE — only the service-role edge function writes.
- `screenings` keeps its existing public SELECT policy; the new `movie_id`
  column is automatically covered by the existing SELECT policy (column-level
  privileges are not restricted). No new write policies are added.
*/

CREATE TABLE IF NOT EXISTS movies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalised_title text NOT NULL,
  display_title text NOT NULL,
  release_year integer,
  tmdb_id bigint UNIQUE,
  poster_path text,
  match_status text NOT NULL DEFAULT 'pending',
  match_confidence numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS movies_normalised_title_key
  ON movies (normalised_title);

ALTER TABLE screenings
  ADD COLUMN IF NOT EXISTS movie_id uuid REFERENCES movies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS screenings_movie_id_idx ON screenings (movie_id);

ALTER TABLE movies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_movies" ON movies;
CREATE POLICY "anon_select_movies" ON movies FOR SELECT
  TO anon, authenticated USING (true);
