alter table public.movies
  add column if not exists poster_match_last_attempted_at timestamptz;

comment on column public.movies.poster_match_last_attempted_at is
  'Last time the poster matcher retried this movie. Used to rotate safely through linked posterless movies.';
