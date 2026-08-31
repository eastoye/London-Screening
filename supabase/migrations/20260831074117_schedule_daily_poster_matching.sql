do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid
    from cron.job
    where jobname = 'daily-match-movie-posters'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;
end
$$;

select cron.schedule(
  'daily-match-movie-posters',
  '0-35/5 3 * * *',
  $schedule$
    select net.http_post(
      url := 'https://czsknzrtumbdweusfyhk.supabase.co/functions/v1/match-movie-posters',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{"mode":"unlinked","max_titles":100}'::jsonb
    );
  $schedule$
);
