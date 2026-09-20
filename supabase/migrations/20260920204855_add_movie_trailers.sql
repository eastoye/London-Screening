ALTER TABLE public.movies
  ADD COLUMN trailer_youtube_key text,
  ADD COLUMN trailer_tmdb_id bigint,
  ADD COLUMN trailer_checked_at timestamptz;

ALTER TABLE public.movies
  ADD CONSTRAINT movies_trailer_youtube_key_valid
  CHECK (
    trailer_youtube_key IS NULL OR (
      trailer_youtube_key ~ '^[A-Za-z0-9_-]{11}$'
      AND trailer_tmdb_id IS NOT NULL
      AND trailer_checked_at IS NOT NULL
    )
  );
