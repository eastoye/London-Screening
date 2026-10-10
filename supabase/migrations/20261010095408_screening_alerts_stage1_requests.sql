/*
# Screening Alerts Stage 1 — Request/Budget/Read Functions

Creates the service-only RPC functions for screening alerts:
- screening_alerts_seed_baseline: seeds the performance ledger from existing screenings
- screening_alerts_budget: per-user and global rate limiting
- screening_alerts_read: returns user preferences, followed films, preview counts
- screening_alerts_request: follow/remove/pause/resume actions with follow limits
- screening_alert_observations: private helper evaluating each performance's alert readiness

All functions are SECURITY INVOKER, service_role only. No browser role can execute them.
No email sending is enabled. This is Stage 1 dry-run only.
*/

-- The schema migration is already installed.
create function public.screening_alerts_seed_baseline() returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_at timestamptz; v_count integer;
begin
  perform private.screening_alert_assert_service();
  perform 1 from private.screening_alert_control where singleton for update;
  if (select baseline_at from private.screening_alert_control where singleton) is not null then
    raise exception 'Baseline already seeded; do not reset the ledger' using errcode='55000';
  end if;
  lock table public.screenings in share mode;
  v_at := clock_timestamp();
  insert into private.screening_alert_performances(source_reference,cinema_name,first_created_at,baseline,reason)
    select source_reference,cinema_name,created_at,true,'baseline' from public.screenings;
  get diagnostics v_count = row_count;
  update private.screening_alert_control set baseline_at=v_at where singleton;
  return jsonb_build_object('baseline_at',v_at,'seeded',v_count,'sending_enabled',false);
end $$;

create function public.screening_alerts_budget(p_user_id uuid, p_action text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_at timestamptz:=clock_timestamp(); v_bucket timestamptz; v_user integer; v_global integer;
begin
  perform private.screening_alert_assert_service();
  if p_user_id is null or p_action is null or p_action not in ('read','search','follow','remove','pause','resume') then
    raise exception 'Invalid budget request' using errcode='22023';
  end if;
  v_bucket:=date_trunc('minute',v_at);
  insert into private.screening_alert_api_limits(scope,bucket,used,user_id) values ('user:'||p_user_id::text,v_bucket,1,p_user_id)
    on conflict(scope,bucket) do update set used=private.screening_alert_api_limits.used+1 returning used into v_user;
  insert into private.screening_alert_api_limits(scope,bucket,used) values ('global',v_bucket,1)
    on conflict(scope,bucket) do update set used=private.screening_alert_api_limits.used+1 returning used into v_global;
  delete from private.screening_alert_api_limits where bucket<v_bucket-interval '2 hours';
  return jsonb_build_object('allowed',v_user<=30 and v_global<=1000,'retry_after',
    greatest(1,ceil(extract(epoch from (v_bucket+interval '1 minute'-v_at)))::integer));
end $$;

create function public.screening_alerts_read(p_user_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$ begin
  perform private.screening_alert_assert_service();
  if p_user_id is null then raise exception 'User required' using errcode='22023'; end if;
  return jsonb_build_object('stage',1,'sending_enabled',false,'email_permission',false,
    'preferences',(select to_jsonb(p) from public.screening_alert_preferences p where user_id=p_user_id),
    'films',coalesce((select jsonb_agg(to_jsonb(f) order by effective_at desc,tmdb_id)
      from public.user_screening_alerts f where user_id=p_user_id and active),'[]'::jsonb),
    'preview_counts',coalesce((select jsonb_object_agg(state,n) from
      (select state,count(*) n from private.screening_alert_items where user_id=p_user_id group by state) q),'{}'::jsonb),
    'latest_preview',(select preview from private.screening_alert_dry_digests where user_id=p_user_id
      order by collection_date desc limit 1));
end $$;

create function public.screening_alerts_request(p_user_id uuid, p_action text, p_tmdb_id bigint default null,
  p_title text default null, p_year integer default null, p_poster text default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_at timestamptz; v_max integer; v_active boolean;
begin
  perform private.screening_alert_assert_service();
  if p_user_id is null or p_action is null or p_action not in ('follow','remove','pause','resume') then
    raise exception 'Invalid action' using errcode='22023';
  end if;
  select max_follows into v_max from private.screening_alert_control where singleton and baseline_at is not null for share;
  if v_max is null then raise exception 'Seed the baseline first' using errcode='55000'; end if;
  perform pg_advisory_xact_lock(hashtextextended('screening-alerts-user:'||p_user_id::text,0));
  v_at:=clock_timestamp();
  insert into public.screening_alert_preferences(user_id,requested_at) values(p_user_id,v_at) on conflict do nothing;
  if p_action in ('follow','remove') and (p_tmdb_id is null or p_tmdb_id not between 1 and 9007199254740991) then
    raise exception 'Invalid TMDB ID' using errcode='22023';
  end if;
  if p_action='follow' then
    select active into v_active from public.user_screening_alerts where user_id=p_user_id and tmdb_id=p_tmdb_id;
    if not coalesce(v_active,false) and
      (select count(*) from public.user_screening_alerts where user_id=p_user_id and active)>=v_max then
      raise exception 'Film follow limit reached' using errcode='54000';
    end if;
    insert into public.user_screening_alerts(user_id,tmdb_id,display_title,release_year,poster_path,effective_at)
      values(p_user_id,p_tmdb_id,p_title,p_year,p_poster,v_at)
      on conflict(user_id,tmdb_id) do update set active=true,display_title=excluded.display_title,
        release_year=excluded.release_year,poster_path=excluded.poster_path,updated_at=v_at,
        effective_at=case when public.user_screening_alerts.active then public.user_screening_alerts.effective_at else v_at end,
        generation=case when public.user_screening_alerts.active then public.user_screening_alerts.generation else gen_random_uuid() end;
  elsif p_action='remove' then
    update public.user_screening_alerts set active=false,updated_at=v_at,generation=gen_random_uuid()
      where user_id=p_user_id and tmdb_id=p_tmdb_id and active;
    update private.screening_alert_items set state='cancelled',reason='film_removed'
      where user_id=p_user_id and tmdb_id=p_tmdb_id and state in ('preview_ready','held');
  elsif p_action='pause' then
    update public.screening_alert_preferences set paused=true,updated_at=v_at,generation=gen_random_uuid()
      where user_id=p_user_id and not paused;
    update private.screening_alert_items set state='cancelled',reason='global_pause'
      where user_id=p_user_id and state in ('preview_ready','held');
  else
    update public.screening_alert_preferences set paused=false,requested_at=v_at,updated_at=v_at,generation=gen_random_uuid()
      where user_id=p_user_id and paused;
  end if;
  return public.screening_alerts_read(p_user_id);
end $$;

create function private.screening_alert_observations(p_now timestamptz)
returns table(source_reference text, cinema_name text, first_created_at timestamptz, baseline boolean,
  accepted_tmdb_id bigint, observed_tmdb_id bigint, run_id uuid, last_seen_at timestamptz,
  start_time timestamptz, booking_url text, projection_formats text[], availability_status text, reason text)
language sql stable security invoker set search_path='' as $$
  select p.source_reference,p.cinema_name,p.first_created_at,p.baseline,p.accepted_tmdb_id,
    case when m.match_status='matched' and m.tmdb_id>0 then m.tmdb_id end,
    r.id,s.last_seen_at,s.start_time,s.booking_url,s.projection_formats,s.availability_status,
    case
      when p.baseline then 'baseline'
      when p.state in ('suppressed','quarantined') then p.reason
      when s.id is null then 'screening_missing'
      when s.cinema_name<>p.cinema_name then 'cinema_identity_conflict'
      when c.cinema_name is null then 'source_unmapped'
      when not c.enabled then 'source_excluded'
      when s.source_reference !~ c.reference_pattern then 'reference_not_approved'
      when r.id is null then 'import_unrecorded'
      when r.status<>'success' then 'import_'||r.status
      when r.completed_at is null or r.completed_at>p_now then 'import_incomplete'
      when r.completed_at<p_now-make_interval(hours=>c.freshness_hours) then 'source_stale'
      when s.last_seen_at not between r.started_at and r.completed_at then 'not_seen_in_successful_run'
      when s.start_time<=p_now then 'expired'
      when not s.active then 'inactive'
      when m.match_status is distinct from 'matched' or m.tmdb_id is null or m.tmdb_id<=0 then 'unconfirmed_film'
      when p.accepted_tmdb_id is not null and p.accepted_tmdb_id<>m.tmdb_id then 'film_identity_conflict'
      when s.sold_out or s.availability_status='sold_out' then 'sold_out'
      else 'ready'
    end
  from private.screening_alert_performances p
  left join public.screenings s on s.source_reference=p.source_reference
  left join public.movies m on m.id=s.movie_id
  left join private.screening_alert_sources c on c.cinema_name=p.cinema_name
  left join lateral (select ir.* from public.import_runs ir where ir.cinema_name=c.run_name
    order by ir.started_at desc,ir.id desc limit 1) r on true;
$$;
revoke all on function private.screening_alert_observations(timestamptz) from public,anon,authenticated;
grant execute on function private.screening_alert_observations(timestamptz) to service_role;

revoke all on function public.screening_alerts_seed_baseline(), public.screening_alerts_budget(uuid,text),
 public.screening_alerts_read(uuid), public.screening_alerts_request(uuid,text,bigint,text,integer,text) from public,anon,authenticated;
grant execute on function public.screening_alerts_seed_baseline(), public.screening_alerts_budget(uuid,text),
 public.screening_alerts_read(uuid), public.screening_alerts_request(uuid,text,bigint,text,integer,text) to service_role;

notify pgrst, 'reload schema';
