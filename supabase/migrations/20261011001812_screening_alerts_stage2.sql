-- Stage 2 is isolated from Stage 1. Existing email=false CHECKs stay intact.
-- This file is the migration source; install ONCE after its versioned copy is in GitHub.
set local lock_timeout='3s';
set local statement_timeout='30s';
create table private.screening_email_control (
 singleton boolean primary key default true check(singleton),
 mode text not null default 'disabled' check(mode in ('disabled','pilot')),
 installed_at timestamptz not null default clock_timestamp(),
 next_provider_attempt_at timestamptz not null default '2000-01-01',
 daily_attempt_limit integer not null default 80 check(daily_attempt_limit between 1 and 100),
 monthly_attempt_limit integer not null default 2400 check(monthly_attempt_limit between 1 and 3000)
);
insert into private.screening_email_control(singleton) values(true);
create table private.screening_email_pilot (
 email text primary key check(email=lower(btrim(email)))
);
create table private.screening_email_suppressions (
 email text primary key,
 reason text not null check(reason in ('bounce','complaint','provider_suppressed')),
 updated_at timestamptz not null default clock_timestamp()
);
create table private.screening_email_mailboxes (
 user_id uuid primary key references auth.users(id) on delete cascade,
 email text not null,
 generation uuid not null default gen_random_uuid(),
 state text not null default 'unverified' check(state in ('unverified','active','unsubscribed','suppressed')),
 consent_at timestamptz,
 verified_at timestamptz,
 active_at timestamptz,
 updated_at timestamptz not null default clock_timestamp(),
 check(state<>'active' or (consent_at is not null and verified_at is not null and active_at is not null))
);
create index screening_email_mailboxes_email on private.screening_email_mailboxes(email);
create table private.screening_email_challenges (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 email text not null,
 generation uuid not null,
 token_hash text not null check(token_hash~'^[0-9a-f]{64}$'),
 expires_at timestamptz not null,
 used_at timestamptz,
 created_at timestamptz not null default clock_timestamp()
);
create index screening_email_challenges_user on private.screening_email_challenges(user_id,created_at desc);
create table private.screening_email_items (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 source_reference text not null references private.screening_alert_performances(source_reference),
 tmdb_id bigint not null,
 follow_generation uuid not null,
 preference_generation uuid not null,
 mailbox_generation uuid not null,
 state text not null default 'pending' check(state in ('pending','reserved','cancelled','suppressed')),
 reason text not null default 'ready',
 created_at timestamptz not null default clock_timestamp(),
 unique(user_id,source_reference)
);
create index screening_email_items_due on private.screening_email_items(user_id,id) where state='pending';
create table private.screening_email_deliveries (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 email text not null,
 mailbox_generation uuid not null,
 kind text not null check(kind in ('verification','digest')),
 collection_date date,
 challenge_id uuid references private.screening_email_challenges(id),
 item_ids uuid[] not null default '{}',
 state text not null default 'draft' check(state in ('draft','ready','sending','accepted','delivered','bounced','complained','failed','cancelled','uncertain','quarantined')),
 payload jsonb,
 performance_snapshot jsonb,
 payload_hash text check(payload_hash~'^[0-9a-f]{64}$'),
 unsubscribe_hash text check(unsubscribe_hash~'^[0-9a-f]{64}$'),
 attempts integer not null default 0,
 first_attempt_at timestamptz,
 retry_at timestamptz not null default clock_timestamp(),
 lease uuid,
 lease_until timestamptz,
 acceptance_uncertain boolean not null default false,
 provider_id uuid unique,
 last_code text,
 created_at timestamptz not null default clock_timestamp(),
 unique(user_id,collection_date),
 check((kind='digest' and collection_date is not null and challenge_id is null) or
       (kind='verification' and collection_date is null and challenge_id is not null)),
 check(attempts=0 or (payload_hash is not null and first_attempt_at is not null and
  (payload is not null or state not in ('draft','ready','sending'))))
);
create index screening_email_deliveries_due on private.screening_email_deliveries(retry_at,id) where state in ('draft','ready','sending');
create index screening_email_deliveries_user on private.screening_email_deliveries(user_id,created_at desc);
create table private.screening_email_attempts (
 id uuid primary key,
 delivery_id uuid not null references private.screening_email_deliveries(id) on delete cascade,
 reserved_at timestamptz not null default clock_timestamp()
);
create index screening_email_attempts_reserved on private.screening_email_attempts(reserved_at);
create table private.screening_email_events (
 event_id text primary key check(length(event_id) between 1 and 200),
 delivery_id uuid,
 provider_id uuid not null,
 event_type text not null,
 provider_at timestamptz not null,
 received_at timestamptz not null default clock_timestamp(),
 matched boolean not null default false
);
do $$ declare t text; begin
 foreach t in array array['screening_email_control','screening_email_pilot','screening_email_suppressions',
  'screening_email_mailboxes','screening_email_challenges','screening_email_items','screening_email_deliveries',
  'screening_email_attempts','screening_email_events'] loop
  execute format('alter table private.%I enable row level security',t);
  execute format('revoke all on private.%I from public,anon,authenticated',t);
  execute format('grant all on private.%I to service_role',t);
 end loop;
end $$;
-- Auth email is read by service invoker only. Browser claims/metadata never choose the destination.
grant select(id,email) on auth.users to service_role;
grant usage on schema auth to service_role;

create function private.screening_email_sync(p_user uuid) returns private.screening_email_mailboxes
language plpgsql security invoker set search_path='' as $$
declare v_email text; m private.screening_email_mailboxes; v_at timestamptz:=clock_timestamp();
begin
 perform private.screening_alert_assert_service();
 perform pg_advisory_xact_lock(hashtextextended('screening-alerts-user:'||p_user::text,0));
 select lower(btrim(email)) into v_email from auth.users where id=p_user;
 if v_email is null or v_email='' or length(v_email)>320 then raise exception 'Account email required' using errcode='23503'; end if;
 insert into private.screening_email_mailboxes(user_id,email) values(p_user,v_email) on conflict do nothing;
 select * into m from private.screening_email_mailboxes where user_id=p_user for update;
 if m.email<>v_email then
  update private.screening_email_mailboxes set email=v_email,state='unverified',generation=gen_random_uuid(),
   consent_at=null,verified_at=null,active_at=null,updated_at=v_at where user_id=p_user returning * into m;
  update private.screening_email_challenges set used_at=v_at where user_id=p_user and used_at is null;
 end if;
 if exists(select 1 from private.screening_email_suppressions where email=v_email) and m.state<>'suppressed' then
  update private.screening_email_mailboxes set state='suppressed',generation=gen_random_uuid(),active_at=null,updated_at=v_at
   where user_id=p_user returning * into m;
 end if;
 update private.screening_email_deliveries set state=case when attempts>0 and acceptance_uncertain then 'uncertain' else 'cancelled' end,
  last_code='mailbox_boundary_changed'
  where user_id=p_user and state in ('draft','ready','sending') and (email<>m.email or mailbox_generation<>m.generation);
 return m;
end $$;

create function public.screening_email_status(p_user_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare m private.screening_email_mailboxes; begin
 m:=private.screening_email_sync(p_user_id);
 return jsonb_build_object('stage',2,'mode',(select mode from private.screening_email_control where singleton),
  'public_sending_enabled',false,'email_state',m.state,'email_permission',m.state='active',
  'verified_at',m.verified_at,'active_at',m.active_at);
end $$;

create function public.screening_email_budget(p_user_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_count integer; v_global integer; v_at timestamptz:=clock_timestamp(); begin
 perform private.screening_alert_assert_service();
 insert into private.screening_alert_api_limits(scope,bucket,used,user_id)
  values('email-user:'||p_user_id::text,date_trunc('minute',v_at),1,p_user_id)
  on conflict(scope,bucket) do update set used=private.screening_alert_api_limits.used+1 returning used into v_count;
 insert into private.screening_alert_api_limits(scope,bucket,used)
  values('email-global',date_trunc('minute',v_at),1)
  on conflict(scope,bucket) do update set used=private.screening_alert_api_limits.used+1 returning used into v_global;
 return jsonb_build_object('allowed',v_count<=10 and v_global<=200,'retry_after',60);
end $$;

create function public.screening_email_request(p_user_id uuid,p_action text,p_token_hash text default null,p_consent boolean default false) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare m private.screening_email_mailboxes; v_at timestamptz:=clock_timestamp(); v_challenge uuid; v_delivery uuid;
begin
 m:=private.screening_email_sync(p_user_id);
 v_at:=clock_timestamp();
 if p_action='disable' then
  update private.screening_email_mailboxes set state=case when state='suppressed' then state else 'unsubscribed' end,
   active_at=null,generation=case when state in ('unsubscribed','suppressed') then generation else gen_random_uuid() end,updated_at=v_at
   where user_id=p_user_id;
  perform private.screening_email_sync(p_user_id);
  return public.screening_email_status(p_user_id);
 end if;
 if p_action<>'request_verification' or p_consent is distinct from true or p_token_hash is null or p_token_hash!~'^[0-9a-f]{64}$' then
  raise exception 'Explicit consent and valid challenge required' using errcode='22023';
 end if;
 if (select mode from private.screening_email_control where singleton)<>'pilot' or
  not exists(select 1 from private.screening_email_pilot where email=m.email) then
  raise exception 'Email pilot is disabled for this address' using errcode='55000';
 end if;
 if m.state='suppressed' then raise exception 'Address suppressed' using errcode='55000'; end if;
 if m.state='active' then return public.screening_email_status(p_user_id); end if;
 if exists(select 1 from private.screening_email_challenges where user_id=p_user_id and created_at>v_at-interval '10 minutes') or
  (select count(*) from private.screening_email_challenges where user_id=p_user_id and created_at>v_at-interval '1 day')>=3 then
  raise exception 'Verification request limit' using errcode='54000';
 end if;
 update private.screening_email_mailboxes set generation=gen_random_uuid(),state='unverified',consent_at=v_at,
  verified_at=null,active_at=null,updated_at=v_at where user_id=p_user_id returning * into m;
 update private.screening_email_challenges set used_at=v_at where user_id=p_user_id and used_at is null;
 perform private.screening_email_sync(p_user_id);
 insert into private.screening_email_challenges(user_id,email,generation,token_hash,expires_at)
  values(p_user_id,m.email,m.generation,p_token_hash,v_at+interval '24 hours') returning id into v_challenge;
 insert into private.screening_email_deliveries(user_id,email,mailbox_generation,kind,challenge_id)
  values(p_user_id,m.email,m.generation,'verification',v_challenge) returning id into v_delivery;
 return jsonb_build_object('challenge_id',v_challenge,'delivery_id',v_delivery,'email',m.email,'public_sending_enabled',false);
end $$;

create function public.screening_email_confirm(p_challenge_id uuid,p_token_hash text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c private.screening_email_challenges; m private.screening_email_mailboxes; v_at timestamptz:=clock_timestamp();
begin
 perform private.screening_alert_assert_service();
 select * into c from private.screening_email_challenges where id=p_challenge_id;
 if not found or c.token_hash is distinct from p_token_hash then return jsonb_build_object('confirmed',false); end if;
 m:=private.screening_email_sync(c.user_id);
 select * into c from private.screening_email_challenges where id=p_challenge_id for update;
 v_at:=clock_timestamp();
 if c.used_at is not null or c.expires_at<=v_at or m.generation<>c.generation or m.email<>c.email or m.state<>'unverified' or
  m.consent_at is null or exists(select 1 from private.screening_email_suppressions where email=m.email) then
  return jsonb_build_object('confirmed',false);
 end if;
 update private.screening_email_challenges set used_at=v_at where id=c.id;
 update private.screening_email_mailboxes set state='active',verified_at=v_at,active_at=v_at,updated_at=v_at where user_id=c.user_id;
 return jsonb_build_object('confirmed',true,'public_sending_enabled',false);
end $$;

create function private.screening_email_valid_items(p_delivery uuid,p_now timestamptz)
returns table(id uuid,body jsonb) language sql stable security invoker set search_path='' as $$
 select i.id,jsonb_build_object('title',f.display_title,'year',f.release_year,'tmdb_id',i.tmdb_id,
  'cinema',o.cinema_name,'start_time',o.start_time,'booking_url',o.booking_url,'projection_formats',o.projection_formats)
 from private.screening_email_deliveries d join private.screening_email_items i on i.id=any(d.item_ids)
 join public.user_screening_alerts f on f.user_id=i.user_id and f.tmdb_id=i.tmdb_id
 join public.screening_alert_preferences g on g.user_id=i.user_id
 join private.screening_email_mailboxes m on m.user_id=i.user_id
 join private.screening_alert_observations(p_now) o on o.source_reference=i.source_reference
 where d.id=p_delivery and i.user_id=d.user_id and f.active and not g.paused and m.state='active'
  and i.follow_generation=f.generation and i.preference_generation=g.generation and i.mailbox_generation=m.generation
  and o.reason='ready' and o.observed_tmdb_id=i.tmdb_id and not o.baseline;
$$;

create function public.screening_email_prepare(p_batch integer default 100,p_now timestamptz default clock_timestamp()) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_user uuid; v_day date:=(p_now at time zone 'Europe/London')::date; v_time time:=(p_now at time zone 'Europe/London')::time;
 v_ids uuid[]; v_n integer:=0; v_stage1 jsonb;
begin
 perform private.screening_alert_assert_service();
 if p_batch is null or p_batch not between 1 and 500 then raise exception 'Invalid batch' using errcode='22023'; end if;
 if (select mode from private.screening_email_control where singleton)='disabled' then return public.screening_email_report(); end if;
 -- Reuse the trusted ledger/observations, never copy Stage 1 items or dry digests.
 v_stage1:=public.screening_alerts_detect(p_batch,p_now);
 if coalesce((v_stage1->>'busy')::boolean,false) or not pg_try_advisory_xact_lock(hashtextextended('screening-email-prepare',0)) then
  return jsonb_build_object('busy',true,'public_sending_enabled',false);
 end if;
 -- Small pilot; sync also invalidates changed Auth addresses before collection.
 for v_user in select m.user_id from private.screening_email_mailboxes m where m.state='active' order by m.user_id limit 50 loop
  perform private.screening_email_sync(v_user);
 end loop;
 insert into private.screening_email_items(user_id,source_reference,tmdb_id,follow_generation,preference_generation,mailbox_generation)
 select f.user_id,p.source_reference,p.accepted_tmdb_id,f.generation,g.generation,m.generation
 from private.screening_alert_performances p join private.screening_alert_observations(p_now) o using(source_reference)
 join public.user_screening_alerts f on f.tmdb_id=p.accepted_tmdb_id and f.active
 join public.screening_alert_preferences g on g.user_id=f.user_id and not g.paused
 join private.screening_email_mailboxes m on m.user_id=f.user_id and m.state='active'
 join auth.users a on a.id=m.user_id and lower(btrim(a.email))=m.email
 join private.screening_email_pilot allowlist on allowlist.email=m.email
 where not p.baseline and p.state='eligible' and o.reason='ready' and o.observed_tmdb_id=p.accepted_tmdb_id
  and p.first_created_at>greatest(f.effective_at,g.requested_at,m.active_at,(select installed_at from private.screening_email_control where singleton))
  and not exists(select 1 from private.screening_email_items existing
   where existing.user_id=f.user_id and existing.source_reference=p.source_reference)
 order by p.first_created_at,p.source_reference,f.user_id limit p_batch on conflict(user_id,source_reference) do nothing;
 update private.screening_email_items i set state='cancelled',reason='subscription_boundary_changed'
 where i.state='pending' and not exists(select 1 from public.user_screening_alerts f
  join public.screening_alert_preferences g using(user_id) join private.screening_email_mailboxes m using(user_id)
  where f.user_id=i.user_id and f.tmdb_id=i.tmdb_id and f.active and not g.paused and m.state='active'
   and f.generation=i.follow_generation and g.generation=i.preference_generation and m.generation=i.mailbox_generation);
 update private.screening_email_items i set reason=o.reason,
  state=case when o.reason in ('sold_out','expired','film_identity_conflict','cinema_identity_conflict') then 'suppressed' else i.state end
  from private.screening_alert_observations(p_now) o where i.source_reference=o.source_reference and i.state='pending';
 if v_time>='08:00'::time and v_time<'12:00'::time then
  for v_user in select distinct i.user_id from private.screening_email_items i where i.state='pending'
   and not exists(select 1 from private.screening_email_deliveries d where d.user_id=i.user_id and
    (d.collection_date=v_day or (d.kind='digest' and d.state in ('ready','sending','uncertain','quarantined'))))
   order by i.user_id limit 10 loop
   perform pg_advisory_xact_lock(hashtextextended('screening-alerts-user:'||v_user::text,0));
   select array_agg(q.id) into v_ids from (select i.id from private.screening_email_items i
    join private.screening_alert_observations(p_now) o using(source_reference)
  where i.user_id=v_user and i.state='pending' and o.reason='ready' order by o.start_time,i.id limit 20) q;
   if coalesce(cardinality(v_ids),0)>0 then
    insert into private.screening_email_deliveries(user_id,email,mailbox_generation,kind,collection_date,item_ids)
     select user_id,email,generation,'digest',v_day,v_ids from private.screening_email_mailboxes where user_id=v_user and state='active'
     on conflict(user_id,collection_date) do nothing;
    update private.screening_email_items set state='reserved' where id=any(v_ids);
    v_n:=v_n+1;
   end if;
  end loop;
 end if;
 return jsonb_build_object('drafts_created',v_n,'public_sending_enabled',false);
end $$;

create function public.screening_email_drafts() returns jsonb
language plpgsql security invoker set search_path='' as $$ begin
 perform private.screening_alert_assert_service();
 -- Verification is rendered immediately from the ephemeral token by the authenticated request.
 return coalesce((select jsonb_agg(to_jsonb(q)) from (select d.id,d.email,d.kind,d.collection_date,
  (select jsonb_agg(v.body order by v.body->>'start_time',v.id) from private.screening_email_valid_items(d.id,clock_timestamp()) v) performances
  from private.screening_email_deliveries d where d.state='draft' and d.kind='digest' order by d.created_at,d.id limit 10) q),'[]'::jsonb);
end $$;

create function public.screening_email_freeze(p_id uuid,p_payload jsonb,p_hash text,p_unsubscribe_hash text default null,p_performances jsonb default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d private.screening_email_deliveries; v_count integer; v_ids uuid[]; v_bodies jsonb; begin
 perform private.screening_alert_assert_service();
 select * into d from private.screening_email_deliveries where id=p_id for update;
 if not found or d.state<>'draft' or d.attempts<>0 then return jsonb_build_object('frozen',false); end if;
 if p_payload->'to' is distinct from jsonb_build_array(d.email) or p_payload->>'from' is null or
  p_payload->>'subject' is null or p_payload->>'html' is null or p_payload->>'text' is null or
  p_payload->'tags' is distinct from jsonb_build_array(jsonb_build_object('name','delivery_id','value',p_id::text)) or
  p_payload ?| array['cc','bcc','attachments','template','scheduled_at'] or length(p_payload::text)>150000 or
  p_hash is null or p_hash!~'^[0-9a-f]{64}$' then raise exception 'Invalid immutable message' using errcode='22023'; end if;
 if d.kind='digest' then
  select count(*) into v_count from private.screening_email_valid_items(d.id,clock_timestamp());
  select array_agg(v.id order by v.body->>'start_time',v.id),jsonb_agg(v.body order by v.body->>'start_time',v.id)
   into v_ids,v_bodies from private.screening_email_valid_items(d.id,clock_timestamp()) v;
  if v_count<>cardinality(d.item_ids) then
   -- Never freeze a stale subset. The worker rerenders a pruned draft next time.
   -- Temporary holds return to pending for a later collection; they are not discarded.
   update private.screening_email_items set state='pending',reason='held_before_freeze'
    where id=any(d.item_ids) and not (id=any(coalesce(v_ids,'{}'::uuid[])));
   update private.screening_email_deliveries set item_ids=coalesce(v_ids,'{}'::uuid[]) where id=d.id;
   return jsonb_build_object('frozen',false);
  end if;
  if v_count=0 then update private.screening_email_deliveries set state='cancelled',last_code='empty_digest' where id=d.id;
   return jsonb_build_object('frozen',false); end if;
  if p_performances is distinct from v_bodies then return jsonb_build_object('frozen',false); end if;
  if p_unsubscribe_hash is null or p_unsubscribe_hash!~'^[0-9a-f]{64}$' or
   p_payload->'headers'->>'List-Unsubscribe' is null or p_payload->'headers'->>'List-Unsubscribe-Post' is distinct from 'List-Unsubscribe=One-Click' then
   raise exception 'Unsubscribe required' using errcode='22023'; end if;
 end if;
 update private.screening_email_deliveries set payload=p_payload,performance_snapshot=p_performances,
  payload_hash=p_hash,unsubscribe_hash=p_unsubscribe_hash,state='ready' where id=d.id;
 return jsonb_build_object('frozen',true);
end $$;

create function public.screening_email_due() returns jsonb
language plpgsql security invoker set search_path='' as $$ begin
 perform private.screening_alert_assert_service();
 return coalesce((select jsonb_agg(id) from (select id from private.screening_email_deliveries
  where (state='ready' and retry_at<=clock_timestamp()) or (state='sending' and lease_until<clock_timestamp())
  order by retry_at,id limit 10) q),'[]'::jsonb);
end $$;

create function public.screening_email_claim(p_id uuid,p_now timestamptz default clock_timestamp()) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d private.screening_email_deliveries; m private.screening_email_mailboxes; c private.screening_email_control;
 v_at timestamptz:=p_now; v_lease uuid; v_valid integer; v_bodies jsonb;
begin
 perform private.screening_alert_assert_service();
 -- Serial quota reservation across independently running workers.
 if p_now is null then raise exception 'Clock required' using errcode='22023'; end if;
 select * into c from private.screening_email_control where singleton for update;
 if c.mode<>'pilot' then return jsonb_build_object('claimed',false,'reason','disabled'); end if;
 select user_id into d.user_id from private.screening_email_deliveries where id=p_id;
 if not found then return jsonb_build_object('claimed',false); end if;
 m:=private.screening_email_sync(d.user_id);
 select * into d from private.screening_email_deliveries where id=p_id for update;
 if d.state='sending' and d.lease_until<v_at then
  update private.screening_email_deliveries set state='ready',acceptance_uncertain=true where id=d.id returning * into d;
 end if;
 if d.state<>'ready' or d.retry_at>v_at then return jsonb_build_object('claimed',false); end if;
 if d.email<>m.email or d.mailbox_generation<>m.generation or m.state in ('unsubscribed','suppressed') or
  not exists(select 1 from private.screening_email_pilot where email=d.email) then
  update private.screening_email_deliveries set state=case when attempts>0 and acceptance_uncertain then 'uncertain' else 'cancelled' end,last_code='mailbox_disabled' where id=d.id;
  return jsonb_build_object('claimed',false);
 end if;
 if d.attempts>=5 or (d.first_attempt_at is not null and d.first_attempt_at<=v_at-interval '23 hours') then
  update private.screening_email_deliveries set state=case when acceptance_uncertain then 'uncertain' else 'failed' end,last_code='retry_window_closed' where id=d.id;
  return jsonb_build_object('claimed',false);
 end if;
 if d.kind='verification' then
  if not exists(select 1 from private.screening_email_challenges where id=d.challenge_id and used_at is null and expires_at>v_at) then
   update private.screening_email_deliveries set state='cancelled',last_code='challenge_expired_or_used' where id=d.id;
   return jsonb_build_object('claimed',false);
  end if;
 else
  if m.state<>'active' then return jsonb_build_object('claimed',false); end if;
  if d.attempts=0 and ((v_at at time zone 'Europe/London')::date<>d.collection_date or
    (v_at at time zone 'Europe/London')::time<'08:00'::time or (v_at at time zone 'Europe/London')::time>='12:00'::time) then
   if (v_at at time zone 'Europe/London')::date>d.collection_date or (v_at at time zone 'Europe/London')::time>='12:00'::time then
    update private.screening_email_deliveries set state='cancelled',last_code='stale_unsent_digest' where id=d.id;
    -- No provider request was made. A temporary hold can recover in a later morning.
    update private.screening_email_items set state='pending',reason='deferred_from_unsent_digest'
     where id=any(d.item_ids) and state='reserved';
   end if;
   return jsonb_build_object('claimed',false);
  end if;
  select count(*),jsonb_agg(v.body order by v.body->>'start_time',v.id) into v_valid,v_bodies
   from private.screening_email_valid_items(d.id,v_at) v;
  if v_valid<>cardinality(d.item_ids) or v_valid=0 then
   if d.attempts>0 then
    update private.screening_email_deliveries set state=case when acceptance_uncertain then 'uncertain' else 'cancelled' end,last_code='eligibility_changed_after_attempt' where id=d.id;
   elsif exists(select 1 from private.screening_email_items i join public.user_screening_alerts f on f.user_id=i.user_id and f.tmdb_id=i.tmdb_id
    join public.screening_alert_preferences g on g.user_id=i.user_id where i.id=any(d.item_ids) and
     (not f.active or g.paused or f.generation<>i.follow_generation or g.generation<>i.preference_generation)) then
    update private.screening_email_deliveries set state='draft',payload=null,performance_snapshot=null,payload_hash=null,unsubscribe_hash=null,
     item_ids=array(select id from private.screening_email_valid_items(d.id,v_at)) where id=d.id;
   else
    -- Failed/running/stale imports are recoverable holds, not permanent exclusions.
    update private.screening_email_deliveries set retry_at=v_at+interval '5 minutes',last_code='source_hold' where id=d.id;
   end if;
   return jsonb_build_object('claimed',false);
  end if;
  if d.performance_snapshot is distinct from v_bodies then
   if d.attempts=0 then
    update private.screening_email_deliveries set state='draft',payload=null,performance_snapshot=null,
     payload_hash=null,unsubscribe_hash=null,last_code='details_changed_before_attempt' where id=d.id;
   else
    -- Frozen retries cannot change bytes. Retain uncertainty for operator reconciliation.
    update private.screening_email_deliveries set state=case when acceptance_uncertain then 'uncertain' else 'cancelled' end,
     last_code='details_changed_after_attempt' where id=d.id;
   end if;
   return jsonb_build_object('claimed',false);
  end if;
 end if;
 if (select count(*) from private.screening_email_attempts where reserved_at>=date_trunc('day',v_at,'UTC'))>=c.daily_attempt_limit or
  (select count(*) from private.screening_email_attempts where reserved_at>=date_trunc('month',v_at,'UTC'))>=c.monthly_attempt_limit then
  return jsonb_build_object('claimed',false,'reason','provider_budget');
 end if;
 if c.next_provider_attempt_at>v_at then return jsonb_build_object('claimed',false,'reason','provider_rate'); end if;
 update private.screening_email_control set next_provider_attempt_at=v_at+interval '1 second' where singleton;
 v_lease:=gen_random_uuid();
 insert into private.screening_email_attempts(id,delivery_id,reserved_at) values(v_lease,d.id,v_at);
 update private.screening_email_deliveries set state='sending',lease=v_lease,lease_until=v_at+interval '2 minutes',
  first_attempt_at=coalesce(first_attempt_at,v_at),attempts=attempts+1,acceptance_uncertain=true where id=d.id;
 return jsonb_build_object('claimed',true,'lease',v_lease,'payload',d.payload,'payload_hash',d.payload_hash,'id',d.id,
  'idempotency_key','screening-alerts/'||d.id::text);
end $$;

create function public.screening_email_finish(p_id uuid,p_lease uuid,p_result text,p_provider_id uuid default null,p_code text default null,p_retry_after integer default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d private.screening_email_deliveries; begin
 perform private.screening_alert_assert_service();
 -- Same control-before-delivery lock order as claims, including shared 429 backoff.
 perform 1 from private.screening_email_control where singleton for update;
 select * into d from private.screening_email_deliveries where id=p_id for update;
 if not found or d.lease is distinct from p_lease then return jsonb_build_object('updated',false); end if;
 -- A worker reply must never overwrite a webhook or a user cancellation.
 if d.state='uncertain' and p_result='accepted' and p_provider_id is not null then
  update private.screening_email_deliveries set state='accepted',provider_id=p_provider_id,acceptance_uncertain=false,last_code=p_code where id=d.id;
  return jsonb_build_object('updated',true);
 end if;
 if d.state not in ('sending','ready') then return jsonb_build_object('updated',false,'state',d.state); end if;
 if p_result not in ('accepted','retry','failed','quarantined') or (p_result='accepted' and p_provider_id is null) then
  raise exception 'Invalid result' using errcode='22023'; end if;
 update private.screening_email_deliveries set state=case when p_result='retry' then 'ready' else p_result end,
  provider_id=coalesce(p_provider_id,provider_id),last_code=left(p_code,120),
  acceptance_uncertain=case when p_result in ('accepted','failed') then false else true end,
  retry_at=clock_timestamp()+make_interval(secs=>greatest(least(3600,60*power(2,d.attempts)::integer),least(86400,coalesce(p_retry_after,0)))),lease_until=null where id=d.id;
 if p_result='retry' and p_code like 'http_429_%' then
  update private.screening_email_control set next_provider_attempt_at=greatest(next_provider_attempt_at,
   clock_timestamp()+make_interval(secs=>greatest(60,least(86400,coalesce(p_retry_after,60))))) where singleton;
 end if;
 return jsonb_build_object('updated',true);
end $$;

create function public.screening_email_unsubscribe(p_delivery_id uuid,p_token_hash text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d private.screening_email_deliveries; m private.screening_email_mailboxes; begin
 perform private.screening_alert_assert_service();
 select * into d from private.screening_email_deliveries where id=p_delivery_id;
 if not found or d.kind<>'digest' or d.unsubscribe_hash is null or d.unsubscribe_hash is distinct from p_token_hash then
  return jsonb_build_object('unsubscribed',false); end if;
 m:=private.screening_email_sync(d.user_id);
 if m.generation=d.mailbox_generation and m.email=d.email then
  perform public.screening_email_request(d.user_id,'disable');
 end if;
 return jsonb_build_object('unsubscribed',true);
end $$;

create function public.screening_email_event(p_event_id text,p_delivery_id uuid,p_provider_id uuid,p_type text,p_at timestamptz) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d private.screening_email_deliveries; v_state text; v_user uuid; begin
 perform private.screening_alert_assert_service();
 -- Idempotent durable evidence. Unknown tags remain visible for investigation.
 insert into private.screening_email_events(event_id,delivery_id,provider_id,event_type,provider_at)
  values(p_event_id,p_delivery_id,p_provider_id,p_type,p_at) on conflict(event_id) do nothing;
 if not found then return jsonb_build_object('recorded',true,'duplicate',true); end if;
 select * into d from private.screening_email_deliveries where id=p_delivery_id or provider_id=p_provider_id order by id limit 1;
 if not found then return jsonb_build_object('recorded',true,'matched',false); end if;
 -- Suppression can affect several accounts with the same address. Lock all in UUID order.
 for v_user in select user_id from private.screening_email_mailboxes where email=d.email or user_id=d.user_id order by user_id loop
  perform pg_advisory_xact_lock(hashtextextended('screening-alerts-user:'||v_user::text,0));
 end loop;
 select * into d from private.screening_email_deliveries where id=d.id for update;
 if (p_delivery_id is not null and p_delivery_id<>d.id) or (d.provider_id is not null and d.provider_id<>p_provider_id) or d.attempts=0 then
  return jsonb_build_object('recorded',true,'matched',false);
 end if;
 update private.screening_email_events set matched=true where event_id=p_event_id;
 v_state:=case p_type when 'email.sent' then 'accepted' when 'email.delivery_delayed' then 'accepted' when 'email.delivered' then 'delivered'
  when 'email.bounced' then 'bounced' when 'email.complained' then 'complained'
  when 'email.failed' then 'failed' when 'email.suppressed' then 'failed' else null end;
 if v_state is not null then
  update private.screening_email_deliveries set provider_id=p_provider_id,acceptance_uncertain=false,
   state=case when state='complained' then state when v_state='complained' then v_state
    when state='bounced' then state when v_state='bounced' then v_state when state='delivered' then state
    when v_state='delivered' then v_state when state='failed' then state else v_state end,
   last_code=p_type where id=d.id;
 end if;
 if p_type in ('email.bounced','email.complained','email.suppressed') then
  insert into private.screening_email_suppressions(email,reason) values(d.email,
   case p_type when 'email.bounced' then 'bounce' when 'email.complained' then 'complaint' else 'provider_suppressed' end)
   on conflict(email) do update set reason=case when private.screening_email_suppressions.reason='complaint' then 'complaint' else excluded.reason end,updated_at=clock_timestamp();
  -- Persistent by address: re-verification or a second account cannot clear it.
  update private.screening_email_mailboxes set state='suppressed',generation=gen_random_uuid(),active_at=null,updated_at=clock_timestamp() where email=d.email;
  update private.screening_email_deliveries set state=case when acceptance_uncertain and attempts>0 then 'uncertain' else 'cancelled' end,last_code='address_suppressed'
   where email=d.email and state in ('draft','ready','sending');
 end if;
 return jsonb_build_object('recorded',true,'matched',true);
end $$;

create function public.screening_email_maintenance() returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_count integer; begin
 perform private.screening_alert_assert_service();
 -- Keep permanent item/digest deduplication, suppression, tokens and provider evidence.
 -- Clear only expired message bodies. Never clear a retryable frozen payload.
 update private.screening_email_deliveries set payload=null,performance_snapshot=null where payload is not null
  and state not in ('draft','ready','sending') and created_at<clock_timestamp()-interval '30 days';
 get diagnostics v_count=row_count;
 update private.screening_email_deliveries d set state='cancelled',last_code='challenge_expired'
  where d.kind='verification' and d.state='draft' and exists(select 1 from private.screening_email_challenges c
   where c.id=d.challenge_id and (c.used_at is not null or c.expires_at<=clock_timestamp()));
 return jsonb_build_object('bodies_cleared',v_count);
end $$;

create function public.screening_email_report() returns jsonb
language plpgsql security invoker set search_path='' as $$ begin
 perform private.screening_alert_assert_service();
 return jsonb_build_object('stage',2,'mode',(select mode from private.screening_email_control where singleton),'public_sending_enabled',false,
  'pilot_addresses',(select count(*) from private.screening_email_pilot),
  'mailbox_states',coalesce((select jsonb_object_agg(state,n) from (select state,count(*) n from private.screening_email_mailboxes group by state) q),'{}'::jsonb),
  'delivery_states',coalesce((select jsonb_object_agg(state,n) from (select state,count(*) n from private.screening_email_deliveries group by state) q),'{}'::jsonb),
  'item_reasons',coalesce((select jsonb_object_agg(reason,n) from (select reason,count(*) n from private.screening_email_items group by reason) q),'{}'::jsonb),
  'unknown_events',(select count(*) from private.screening_email_events where not matched),
  'attempts_today',(select count(*) from private.screening_email_attempts where reserved_at>=date_trunc('day',clock_timestamp())),
  'oldest_queued_at',(select min(created_at) from private.screening_email_deliveries where state in ('draft','ready','sending')),
  'stage1_sending_enabled',(select sending_enabled from private.screening_alert_control where singleton));
end $$;

-- Explicit function grants; no browser RPC, no SECURITY DEFINER, no default grant change.
do $$ declare f record; begin
 for f in select p.oid::regprocedure name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','private') and p.proname like 'screening_email_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.name);
  execute format('grant execute on function %s to service_role',f.name);
 end loop;
end $$;
notify pgrst,'reload schema';
