-- OPTIONAL: reviewed scheduler installation, separate from the schema migration.
-- Creates ONE INACTIVE job. This script never activates a job or sends an HTTP request.
-- Run only after committed source and all four deployed functions are verified.
-- The existing worker secret must later be stored in Vault under the name
-- screening_alerts_worker_secret. Never put its value in SQL/source/chat.
begin;
set local lock_timeout='3s';
do $install$
declare job_id bigint;
begin
 if to_regclass('private.screening_email_control') is null then
  raise exception 'Install and verify the Stage 2 migration first';
 end if;
 if exists(select 1 from cron.job where jobname='screening-alerts-email-stage2') then
  raise exception 'Stage 2 scheduler already exists; inspect it rather than overwriting it';
 end if;
 job_id:=cron.schedule('screening-alerts-email-stage2','*/5 * * * *',$command$
  with worker as (
   select decrypted_secret from vault.decrypted_secrets
   where name='screening_alerts_worker_secret' and length(decrypted_secret) between 32 and 512
  ), permitted as (
   select 1 from private.screening_email_control where singleton and mode='pilot'
  )
  select net.http_post(
   url:='https://czsknzrtumbdweusfyhk.supabase.co/functions/v1/process-screening-alerts-email',
   headers:=jsonb_build_object('Content-Type','application/json',
    'x-screening-alerts-worker-secret',worker.decrypted_secret),
   body:='{"action":"process"}'::jsonb,
   timeout_milliseconds:=120000
  ) from worker cross join permitted where (select count(*) from worker)=1;
 $command$);
 perform cron.alter_job(job_id,active:=false);
end $install$;
commit;

-- Safe inspection: command and secret values are deliberately omitted.
select jobid,jobname,schedule,active from cron.job where jobname='screening-alerts-email-stage2';
-- Expected active=false. Activation is a separate, deliberate pilot step.
