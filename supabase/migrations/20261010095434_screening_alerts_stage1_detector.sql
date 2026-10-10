/*
# Screening Alerts Stage 1 — Report and Detector Functions

Creates two service-only RPC functions:
- screening_alerts_report: dry-run status report with performance reasons, item states, source coverage
- screening_alerts_detect: batch collection of new performances, evaluation, alert item creation, and
  bounded morning dry-run digest generation (08:00–12:00 London time)

All functions are SECURITY INVOKER, service_role only. No email sending. Stage 1 dry-run only.
*/

create function public.screening_alerts_report() returns jsonb
language plpgsql security invoker set search_path='' as $$ begin
  perform private.screening_alert_assert_service();
  return jsonb_build_object('stage',1,'mode','dry_run','sending_enabled',false,'emails_sent',0,
    'baseline_at',(select baseline_at from private.screening_alert_control where singleton),
    'performance_reasons',coalesce((select jsonb_object_agg(reason,n) from
      (select reason,count(*) n from private.screening_alert_performances group by reason) q),'{}'::jsonb),
    'item_states',coalesce((select jsonb_object_agg(state,n) from
      (select state,count(*) n from private.screening_alert_items group by state) q),'{}'::jsonb),
    'uncollected',(select count(*) from public.screenings s where not exists
      (select 1 from private.screening_alert_performances p where p.source_reference=s.source_reference)),
    'source_coverage',coalesce((select jsonb_agg(to_jsonb(q) order by cinema_name) from (
      select s.cinema_name,count(*) upcoming,
        count(*) filter(where m.match_status='matched' and m.tmdb_id>0) exact_matched,
        coalesce(bool_or(c.enabled),false) source_enabled,
        count(*) filter(where c.enabled and s.source_reference~c.reference_pattern) approved_reference,
        max(c.run_name) import_run_name,max(r.status) latest_import_status,max(r.completed_at) latest_completed_at,
        count(*) filter(where r.status='success' and r.completed_at between clock_timestamp()-make_interval(hours=>c.freshness_hours) and clock_timestamp()
          and s.last_seen_at between r.started_at and r.completed_at) fresh_upcoming
      from public.screenings s left join public.movies m on m.id=s.movie_id
      left join private.screening_alert_sources c on c.cinema_name=s.cinema_name
      left join lateral (select ir.status,ir.completed_at,ir.started_at from public.import_runs ir
        where ir.cinema_name=c.run_name order by ir.started_at desc,ir.id desc limit 1) r on true
      where s.active and s.start_time>clock_timestamp() group by s.cinema_name
    ) q),'[]'::jsonb),
    'last_run',(select to_jsonb(r) from private.screening_alert_dry_runs r order by observed_at desc limit 1));
end $$;

create function public.screening_alerts_detect(p_batch_size integer default 500, p_now timestamptz default clock_timestamp()) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_baseline timestamptz; v_collected integer; v_evaluated integer; v_digests integer:=0;
  v_day date; v_time time; v_user uuid; v_ids uuid[]; v_preview jsonb;
begin
  perform private.screening_alert_assert_service();
  if p_batch_size is null or p_batch_size not between 1 and 1000 or p_now is null then
    raise exception 'Batch size must be 1..1000 and clock required' using errcode='22023';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('screening-alerts-stage1-detector',0)) then
    return jsonb_build_object('busy',true,'sending_enabled',false,'emails_sent',0);
  end if;
  select baseline_at into v_baseline from private.screening_alert_control where singleton for update;
  if v_baseline is null then raise exception 'Seed the baseline first' using errcode='55000'; end if;
  insert into private.screening_alert_performances(source_reference,cinema_name,first_created_at,baseline,reason)
    select s.source_reference,s.cinema_name,s.created_at,s.created_at<=v_baseline,
      case when s.created_at<=v_baseline then 'baseline' else 'not_evaluated' end
    from public.screenings s where not exists
      (select 1 from private.screening_alert_performances p where p.source_reference=s.source_reference)
    order by s.created_at,s.id limit p_batch_size on conflict do nothing;
  get diagnostics v_collected = row_count;
  drop table if exists pg_temp.screening_alert_batch;
  create temporary table screening_alert_batch on commit drop as
    select o.* from private.screening_alert_observations(p_now) o
    join private.screening_alert_performances p using(source_reference)
    where not p.baseline and p.state in ('pending','eligible')
    order by p.last_evaluated_at nulls first,p.source_reference limit p_batch_size;
  get diagnostics v_evaluated = row_count;
  update private.screening_alert_performances p set
    state=case when b.reason='ready' then 'eligible' when b.reason in ('sold_out','expired') then 'suppressed'
      when b.reason in ('film_identity_conflict','cinema_identity_conflict') then 'quarantined' else 'pending' end,
    reason=b.reason,last_evaluated_at=p_now,source_run_id=b.run_id,observed_last_seen_at=b.last_seen_at,
    accepted_tmdb_id=case when b.reason='ready' then coalesce(p.accepted_tmdb_id,b.observed_tmdb_id) else p.accepted_tmdb_id end
    from pg_temp.screening_alert_batch b where b.source_reference=p.source_reference;
  insert into private.screening_alert_items(user_id,source_reference,tmdb_id,follow_generation,preference_generation,state,reason)
    select f.user_id,p.source_reference,p.accepted_tmdb_id,f.generation,g.generation,
      case when b.reason='ready' then 'preview_ready' else 'held' end,b.reason
    from pg_temp.screening_alert_batch b join private.screening_alert_performances p using(source_reference)
    join public.user_screening_alerts f on f.tmdb_id=p.accepted_tmdb_id and f.active
    join public.screening_alert_preferences g on g.user_id=f.user_id and not g.paused
    where p.first_created_at>greatest(f.effective_at,g.requested_at) and p.state in ('pending','eligible')
    on conflict(user_id,source_reference) do nothing;
  update private.screening_alert_items i set
    state=case when p.state='quarantined' then 'quarantined' when p.state='suppressed' then 'suppressed'
      when b.reason='ready' then 'preview_ready' else 'held' end,reason=b.reason
    from pg_temp.screening_alert_batch b join private.screening_alert_performances p using(source_reference)
    where i.source_reference=p.source_reference and i.state in ('preview_ready','held');
  update private.screening_alert_items i set state='cancelled',reason='subscription_boundary_changed'
    where i.state in ('preview_ready','held') and not exists (
      select 1 from public.user_screening_alerts f join public.screening_alert_preferences g using(user_id)
      where f.user_id=i.user_id and f.tmdb_id=i.tmdb_id and f.active and not g.paused
        and f.generation=i.follow_generation and g.generation=i.preference_generation);
  v_day:=(p_now at time zone 'Europe/London')::date;
  v_time:=(p_now at time zone 'Europe/London')::time;
  if v_time>='08:00'::time and v_time<'12:00'::time then
    for v_user in select distinct i.user_id from private.screening_alert_items i
      where i.state='preview_ready' and not exists(select 1 from private.screening_alert_dry_digests d
        where d.user_id=i.user_id and d.collection_date=v_day) order by i.user_id limit 50 loop
      select array_agg(q.id order by q.start_time,q.id),jsonb_build_object('mode','dry_run','email_permission',false,
        'collection_date',v_day,'performances',jsonb_agg(q.body order by q.start_time,q.id))
        into v_ids,v_preview from (
        select i.id,o.start_time,jsonb_build_object('source_reference',o.source_reference,'tmdb_id',i.tmdb_id,
          'title',f.display_title,'year',f.release_year,'cinema',o.cinema_name,'start_time',o.start_time,
          'projection_formats',o.projection_formats,'availability',o.availability_status,
          'booking_url',case when o.booking_url like 'https://%' then o.booking_url end,
          'item_id',i.id) body
        from private.screening_alert_items i join private.screening_alert_observations(p_now) o using(source_reference)
        join public.user_screening_alerts f on f.user_id=i.user_id and f.tmdb_id=i.tmdb_id and f.active
        join public.screening_alert_preferences g on g.user_id=i.user_id and not g.paused
        where i.user_id=v_user and i.state='preview_ready' and o.reason='ready'
          and o.observed_tmdb_id=i.tmdb_id and f.generation=i.follow_generation and g.generation=i.preference_generation
        order by o.start_time,i.id limit 200
      ) q;
      if coalesce(cardinality(v_ids),0)>0 then
        insert into private.screening_alert_dry_digests(user_id,collection_date,item_ids,preview) values(v_user,v_day,v_ids,v_preview);
        update private.screening_alert_items set state='previewed',reason='dry_run_only' where id=any(v_ids);
        v_digests:=v_digests+1;
      end if;
    end loop;
  end if;
  insert into private.screening_alert_dry_runs(observed_at,collected,evaluated,digests_created)
    values(p_now,v_collected,v_evaluated,v_digests);
  delete from private.screening_alert_dry_runs where id in
    (select id from private.screening_alert_dry_runs order by observed_at desc,id desc offset 100);
  delete from private.screening_alert_dry_digests where collection_date<v_day-7;
  delete from private.screening_alert_api_limits where bucket<clock_timestamp()-interval '2 hours';
  return jsonb_build_object('collected',v_collected,'evaluated',v_evaluated,'digests_created',v_digests,
    'report',public.screening_alerts_report(),'emails_sent',0,'sending_enabled',false);
end $$;

revoke all on function public.screening_alerts_seed_baseline(), public.screening_alerts_budget(uuid,text),
 public.screening_alerts_read(uuid), public.screening_alerts_request(uuid,text,bigint,text,integer,text),
 public.screening_alerts_report(), public.screening_alerts_detect(integer,timestamptz) from public,anon,authenticated;
grant execute on function public.screening_alerts_seed_baseline(), public.screening_alerts_budget(uuid,text),
 public.screening_alerts_read(uuid), public.screening_alerts_request(uuid,text,bigint,text,integer,text),
 public.screening_alerts_report(), public.screening_alerts_detect(integer,timestamptz) to service_role;

notify pgrst, 'reload schema';
