do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid
    from cron.job
    where jobname = 'daily-retry-posterless-movies'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;
end
$$;

select cron.schedule(
  'daily-retry-posterless-movies',
  '0,15,30,45 4 * * *',
  $$
    select net.http_post(
      url := 'https://czsknzrtumbdweusfyhk.supabase.co/functions/v1/match-movie-posters',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{"mode":"retry","max_titles":100,"retry_after_days":7}'::jsonb
    );
  $$
);