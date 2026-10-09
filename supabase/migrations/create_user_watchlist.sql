create table public.user_watchlist (
  user_id uuid not null,
  tmdb_id bigint not null,
  display_title text not null,
  release_year integer,
  poster_path text,
  added_at timestamptz not null default now(),
  metadata_updated_at timestamptz not null default now(),

  constraint user_watchlist_pkey
    primary key (user_id, tmdb_id),

  constraint user_watchlist_user_id_fkey
    foreign key (user_id)
    references auth.users (id)
    on delete cascade,

  constraint user_watchlist_tmdb_id_positive
    check (tmdb_id > 0),

  constraint user_watchlist_display_title_not_empty
    check (length(btrim(display_title)) > 0),

  constraint user_watchlist_release_year_valid
    check (
      release_year is null
      or release_year between 1800 and 2200
    )
);

comment on table public.user_watchlist is
  'User-owned native London Screenings watchlist, identified by verified TMDB movie IDs.';

comment on column public.user_watchlist.tmdb_id is
  'Server-verified TMDB movie ID and authoritative saved-film identity.';

comment on column public.user_watchlist.display_title is
  'TMDB title snapshot verified by the native watchlist Edge Function.';

comment on column public.user_watchlist.release_year is
  'TMDB release-year snapshot used for display and version recognition.';

comment on column public.user_watchlist.poster_path is
  'TMDB poster-path snapshot; may be null.';

alter table public.user_watchlist
  enable row level security;

revoke all
  on table public.user_watchlist
  from public, anon, authenticated;

grant select, delete
  on table public.user_watchlist
  to authenticated;

grant select, insert, update, delete
  on table public.user_watchlist
  to service_role;

create policy "Users can view their own watchlist"
  on public.user_watchlist
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can remove items from their own watchlist"
  on public.user_watchlist
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create index user_watchlist_tmdb_id_idx
  on public.user_watchlist (tmdb_id);
