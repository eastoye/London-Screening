-- Local test fixture only; never install in Supabase.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
create table public.movies(id uuid primary key default gen_random_uuid(),tmdb_id bigint,match_status text);
create table public.import_runs(id uuid primary key default gen_random_uuid(),cinema_name text,status text,
  started_at timestamptz,completed_at timestamptz);
create table public.screenings(id uuid primary key default gen_random_uuid(),cinema_name text,source_reference text unique,
  created_at timestamptz default clock_timestamp(),last_seen_at timestamptz,start_time timestamptz,booking_url text,
  projection_formats text[] default '{}',active boolean default true,sold_out boolean default false,
  availability_status text default 'unknown',movie_id uuid references public.movies(id));
