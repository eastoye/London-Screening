set local lock_timeout = '3s';
set local statement_timeout = '30s';
-- Stage 1 only. Generate the migration filename with `supabase migration new`.
-- Run once against the confirmed application project. No email delivery code.
create schema if not exists private;
-- The inspected project has no completed-run lookup index. Keep freshness
-- checks from repeatedly scanning the historical importer log.
create index screening_alerts_import_runs_latest_idx
  on public.import_runs(cinema_name,started_at desc,id desc);

create table public.screening_alert_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  paused boolean not null default false,
  requested_at timestamptz not null default clock_timestamp(),
  generation uuid not null default gen_random_uuid(),
  email_enabled boolean not null default false check (email_enabled = false),
  updated_at timestamptz not null default clock_timestamp()
);
create table public.user_screening_alerts (
  user_id uuid not null references auth.users(id) on delete cascade,
  tmdb_id bigint not null check (tmdb_id between 1 and 9007199254740991),
  display_title text not null check (length(display_title) between 1 and 500),
  release_year integer check (release_year between 1870 and 2200),
  poster_path text check (poster_path is null or poster_path like '/%'),
  active boolean not null default true,
  effective_at timestamptz not null default clock_timestamp(),
  generation uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, tmdb_id)
);
create index user_screening_alerts_active_tmdb on public.user_screening_alerts(tmdb_id, user_id) where active;
alter table public.screening_alert_preferences enable row level security;
alter table public.user_screening_alerts enable row level security;
create policy screening_alert_preferences_owner_read on public.screening_alert_preferences
  for select to authenticated using ((select auth.uid()) = user_id);
create policy user_screening_alerts_owner_read on public.user_screening_alerts
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.screening_alert_preferences, public.user_screening_alerts from public, anon, authenticated;
grant select on public.screening_alert_preferences, public.user_screening_alerts to authenticated;
grant all on public.screening_alert_preferences, public.user_screening_alerts to service_role;

create table private.screening_alert_control (
  singleton boolean primary key default true check (singleton),
  baseline_at timestamptz,
  sending_enabled boolean not null default false check (sending_enabled = false),
  max_follows integer not null default 200 check (max_follows between 1 and 1000)
);
insert into private.screening_alert_control(singleton) values (true);
create table private.screening_alert_sources (
  cinema_name text primary key,
  run_name text not null,
  reference_pattern text not null,
  enabled boolean not null default true,
  exclusion_reason text,
  freshness_hours integer not null default 36 check (freshness_hours between 1 and 168)
);
-- Allow only actual source IDs matching the approved form; legacy/fallback keys hold.
insert into private.screening_alert_sources(cinema_name,run_name,reference_pattern,enabled,exclusion_reason) values
 ('ActOne Cinema','ActOne Cinema','^actone:[0-9]+$',true,null),
 ('ArtHouse Crouch End','ArtHouse Crouch End','^arthouse:[0-9]+$',true,null),
 ('Barbican Cinema','Barbican Cinema','^barbican:spektrix:[0-9]+$',true,null),
 ('Bertha DocHouse','Bertha DocHouse','^bertha-dochouse:curzon:[A-Za-z0-9-]+$',true,null),
 ('BFI IMAX','BFI IMAX','^bfi-imax:[0-9A-Fa-f-]{36}$',true,null),
 ('BFI Southbank','BFI Southbank','^bfi-southbank:[0-9A-Fa-f-]{36}$',true,null),
 ('Castle Sidcup','Castle Sidcup','^castle-sidcup:performance:[0-9]+$',true,null),
 ('Ciné Lumière','Ciné Lumière','^cinelumiere:[0-9]+$',true,null),
 ('Close-Up Film Centre','Close-Up Film Centre','^closeup:ticketsource:[0-9]+$',true,null),
 ('Coldharbour Blue','Coldharbour Blue','^coldharbour-blue:event:[0-9]+$',true,null),
 ('David Lean Cinema','David Lean Cinema','^davidlean:',false,'unstable_performance_identity'),
 ('Electric Cinema Portobello','Electric Cinemas','^electric:portobello:[0-9]+$',true,null),
 ('Electric Cinema White City','Electric Cinemas','^electric:white-city:[0-9]+$',true,null),
 ('Forest Cinema Walthamstow','Forest Cinema Walthamstow','^forest-walthamstow:performance:[0-9]+$',true,null),
 ('Genesis Cinema','Genesis Cinema','^genesis:[0-9]+$',true,null),
 ('ICA Cinema','ICA Cinema','^ica:',false,'unstable_performance_identity'),
 ('JW3 Cinema','JW3 Cinema','^jw3:spektrix:[A-Za-z0-9]+$',true,null),
 ('Kiln Cinema','Kiln Cinema','^kiln:spektrix:[A-Za-z0-9]+$',true,null),
 ('Lumiere Romford','Lumiere Romford','^lumiere-romford:showtime:[A-Za-z0-9_=+-]+$',true,null),
 ('Metro Cinema','Metro Cinema','^metro-cinema:showtime:[A-Za-z0-9_=+-]+$',true,null),
 ('Olympic Cinema Barnes','Olympic Cinema Barnes','^olympic:barnes:[0-9]+$',true,null),
 ('Peckhamplex','Peckhamplex','^peckhamplex:[0-9]+$',true,null),
 ('Phoenix Cinema','Phoenix Cinema','^phoenix:[0-9]+$',true,null),
 ('Prince Charles Cinema','Prince Charles Cinema','^pcc:[0-9]+$',true,null),
 ('Regent Street Cinema','Regent Street Cinema','^regent:[0-9]+$',true,null),
 ('Rich Mix','Rich Mix','^richmix:spektrix:[A-Za-z0-9]+$',true,null),
 ('Rio Cinema','Rio Cinema','^rio:[0-9]+$',true,null),
 ('Riverside Studios','Riverside Studios','^riverside:spektrix:[A-Za-z0-9]+$',true,null),
 ('Science Museum IMAX','Science Museum IMAX','^science-museum-imax:[0-9]+$',true,null),
 ('The Arzner','The Arzner','^arzner:performance:[0-9]+$',true,null),
 ('The Castle Cinema','The Castle Cinema','^castle:[0-9]+$',true,null),
 ('The Chiswick Cinema','The Chiswick Cinema','^chiswick:[0-9]+$',true,null),
 ('The Cinema at Selfridges','Olympic Cinemas','^olympic:selfridges:[0-9]+$',true,null),
 ('The Cinema in the Arches','Olympic Cinemas','^olympic:arches:[0-9]+$',true,null),
 ('The Cinema in the Power Station','Olympic Cinemas','^olympic:power-station:[0-9]+$',true,null),
 ('The Garden Cinema','The Garden Cinema','^garden:[0-9]+$',true,null),
 ('The Lexi Cinema','The Lexi Cinema','^lexi:[0-9]+$',true,null),
 ('The Nickel','The Nickel','^nickel:[0-9]+$',true,null);

create table private.screening_alert_performances (
  source_reference text primary key,
  cinema_name text not null,
  first_created_at timestamptz not null,
  baseline boolean not null,
  accepted_tmdb_id bigint,
  state text not null default 'pending' check (state in ('pending','eligible','suppressed','quarantined')),
  reason text not null default 'not_evaluated',
  last_evaluated_at timestamptz,
  source_run_id uuid,
  observed_last_seen_at timestamptz
);
create index screening_alert_performances_due on private.screening_alert_performances(last_evaluated_at,source_reference)
  where not baseline and state in ('pending','eligible');
create table private.screening_alert_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_reference text not null references private.screening_alert_performances(source_reference),
  tmdb_id bigint not null,
  follow_generation uuid not null,
  preference_generation uuid not null,
  state text not null check (state in ('preview_ready','held','previewed','cancelled','suppressed','quarantined')),
  reason text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,source_reference)
);
create index screening_alert_items_pending on private.screening_alert_items(user_id,source_reference)
  where state in ('preview_ready','held');
create table private.screening_alert_dry_digests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  collection_date date not null,
  mode text not null default 'dry_run' check (mode = 'dry_run'),
  item_ids uuid[] not null,
  preview jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,collection_date)
);
create table private.screening_alert_dry_runs (
  id uuid primary key default gen_random_uuid(),
  observed_at timestamptz not null,
  collected integer not null,
  evaluated integer not null,
  digests_created integer not null,
  mode text not null default 'dry_run' check (mode = 'dry_run')
);
create table private.screening_alert_api_limits (
  scope text not null,
  bucket timestamptz not null,
  used integer not null,
  user_id uuid references auth.users(id) on delete cascade,
  primary key(scope,bucket)
);
create index screening_alert_api_limits_user on private.screening_alert_api_limits(user_id) where user_id is not null;
create index screening_alert_api_limits_bucket on private.screening_alert_api_limits(bucket);
-- No broad private-schema grants or default privileges are changed.
grant usage on schema private to service_role;
do $$ declare t text; begin
  foreach t in array array['screening_alert_control','screening_alert_sources','screening_alert_performances',
    'screening_alert_items','screening_alert_dry_digests','screening_alert_dry_runs','screening_alert_api_limits'] loop
    execute format('alter table private.%I enable row level security',t);
    execute format('revoke all on private.%I from public, anon, authenticated',t);
    execute format('grant all on private.%I to service_role',t);
  end loop;
end $$;
grant select on public.screenings, public.movies, public.import_runs to service_role;

-- All RPCs are SECURITY INVOKER and service-only. They never accept a browser
-- identity directly: the Edge Function supplies the independently verified ID.
create function private.screening_alert_assert_service() returns void
language plpgsql security invoker set search_path='' as $$ begin
  if current_user not in ('service_role','postgres') then
    raise exception 'Service access required' using errcode='42501';
  end if;
end $$;
revoke all on function private.screening_alert_assert_service() from public, anon, authenticated;
grant execute on function private.screening_alert_assert_service() to service_role;

