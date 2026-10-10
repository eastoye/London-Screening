select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n
  on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'user_watchlist';

select
  policyname,
  roles,
  cmd,
  qual,
  with_check
from pg_catalog.pg_policies
where schemaname = 'public'
  and tablename = 'user_watchlist'
order by policyname;

select
  grantee,
  string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'user_watchlist'
  and grantee in ('anon', 'authenticated', 'service_role')
group by grantee
order by grantee;

select
  indexname,
  indexdef
from pg_catalog.pg_indexes
where schemaname = 'public'
  and tablename = 'user_watchlist'
order by indexname;
