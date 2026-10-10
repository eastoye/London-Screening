-- Read-only verification. Run in czsknzrtumbdweusfyhk after the two pending SQL files.
select version(),current_database();

select c.relname,c.relrowsecurity,
 has_table_privilege('anon',c.oid,'SELECT') as anon_select,
 has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_select,
 has_table_privilege('authenticated',c.oid,'INSERT') as authenticated_insert,
 has_table_privilege('authenticated',c.oid,'UPDATE') as authenticated_update,
 has_table_privilege('authenticated',c.oid,'DELETE') as authenticated_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='user_watchlist';

select policyname,roles,cmd,qual,with_check from pg_policies
where schemaname='public' and tablename in
 ('user_watchlist','screening_alert_preferences','user_screening_alerts')
order by tablename,policyname;

-- Expect nine rows, all RLS true. Only the two public alert tables permit owner SELECT.
select n.nspname as schema_name,c.relname,c.relrowsecurity,
 has_table_privilege('anon',c.oid,'SELECT') as anon_select,
 has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_select,
 has_table_privilege('authenticated',c.oid,'INSERT') as authenticated_insert,
 has_table_privilege('authenticated',c.oid,'UPDATE') as authenticated_update,
 has_table_privilege('authenticated',c.oid,'DELETE') as authenticated_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where c.relkind='r' and n.nspname in ('public','private')
 and (c.relname like 'screening_alert%' or c.relname='user_screening_alerts')
order by n.nspname,c.relname;

-- Expect eight rows after completing installation: two private helpers and six public RPCs.
-- All security_definer / browser execute values must be false, service_execute true.
select n.nspname as schema_name,p.proname,pg_get_function_identity_arguments(p.oid) as arguments,
 p.prosecdef as security_definer,p.proconfig,
 has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','private') and p.proname like 'screening_alert%'
order by n.nspname,p.proname;

select singleton,baseline_at,sending_enabled,max_follows from private.screening_alert_control;
select count(*) as source_venues,count(*) filter(where enabled) as enabled_sources
from private.screening_alert_sources;
select cinema_name,run_name,enabled,exclusion_reason from private.screening_alert_sources
where cinema_name<>run_name or not enabled order by cinema_name;

select n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid) as definition
from pg_constraint k join pg_class c on c.oid=k.conrelid
join pg_namespace n on n.oid=c.relnamespace
where c.relname in ('screening_alert_control','screening_alert_preferences') and k.contype='c'
order by c.relname,k.conname;

-- This is a report only, not seeding or detection. Run after both pending SQL files succeed.
select public.screening_alerts_report();
