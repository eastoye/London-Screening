-- Read-only acceptance reference. Run AFTER the Stage 2 migration is installed.
-- Uses no provider credentials, sends nothing, and returns no email addresses.
begin read only;
set local role service_role;

select public.screening_email_report() as stage2_report;

select baseline_at, sending_enabled as stage1_sending_enabled
from private.screening_alert_control where singleton;

select mode, installed_at, daily_attempt_limit, monthly_attempt_limit
from private.screening_email_control where singleton;

-- Expected: nine rows, RLS=true, browser_access=false, service_access=true.
select c.relname as table_name, c.relrowsecurity as rls_enabled,
 has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') as anon_access,
 has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') as authenticated_access,
 has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE') as service_access
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='private' and c.relkind='r' and c.relname like 'screening_email_%'
order by c.relname;

-- Expected: security_definer=false, browser_execute=false, service_execute=true.
select p.oid::regprocedure::text as function_name, p.prosecdef as security_definer,
 p.proconfig as function_configuration,
 has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','private') and p.proname like 'screening_email_%'
order by n.nspname,p.proname;

-- The original Stage 1 hard-false constraints must still be present.
select conrelid::regclass::text as table_name,conname,pg_get_constraintdef(oid) as definition
from pg_constraint
where contype='c' and conrelid in
 ('private.screening_alert_control'::regclass,'public.screening_alert_preferences'::regclass)
order by table_name,conname;

-- Independent outbox and preview counts; neither query sends email.
select (select count(*) from private.screening_alert_performances where baseline) as baseline_performances,
 (select count(*) from private.screening_alert_dry_digests) as stage1_preview_digests,
 (select count(*) from private.screening_email_items) as stage2_items,
 (select count(*) from private.screening_email_deliveries) as stage2_deliveries,
 (select count(*) from private.screening_email_attempts) as stage2_attempts;
commit;
