-- Extension dependency audit (read-only).
--
-- Purpose: after a database migration or backend switch, detect functions
-- whose definitions depend on extension surfaces that may not exist in the
-- target database (the 2026-11-12 console login outage was caused by the
-- pgcrypto extension missing from the PG17 ivrm_dashboard database while
-- Supabase-era functions called digest() via the extensions schema).
--
-- Usage: psql -d <database> -f supabase/checks/extension_dependencies.sql
-- Interpretation: every row in section 2 with status = 'MISSING' is a latent
-- failure: the function parses, but calling it (or a code path inside it)
-- fails at runtime. Resolve by installing the extension in the schema the
-- function expects, or by rewriting the function. See
-- docs/db-backend-switch-verification.md and Issue #206.

-- Section 1: installed extensions.
select
  e.extname,
  e.extversion,
  n.nspname as installed_in_schema
from pg_extension e
join pg_namespace n on n.oid = e.extnamespace
order by e.extname;

-- Section 2: function references to extension surfaces vs. installed state.
with refs as (
  select
    p.proname as function_name,
    dep.dependency,
    dep.provided_by
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral (
    values
      ('pgcrypto function (digest/crypt/gen_salt)', 'pgcrypto',
       pg_get_functiondef(p.oid) ~* '\m(digest|crypt|gen_salt|hmac)\s*\('),
      ('extensions schema reference', 'pgcrypto (Supabase layout)',
       pg_get_functiondef(p.oid) ilike '%extensions.%'),
      ('vault schema reference (Supabase Vault)', 'supabase_vault',
       pg_get_functiondef(p.oid) ilike '%vault.%'),
      ('pg_net call (net.http_*)', 'pg_net',
       pg_get_functiondef(p.oid) ilike '%net.http%'),
      ('pg_cron reference (cron.*)', 'pg_cron',
       pg_get_functiondef(p.oid) ilike '%cron.%')
  ) as dep(dependency, provided_by, matched)
  where n.nspname = 'public'
    and p.prokind = 'f'
    and dep.matched
    -- exclude functions that belong to an extension themselves
    -- (e.g. pgcrypto's own digest() when installed in public)
    and not exists (
      select 1 from pg_depend d
      where d.objid = p.oid and d.deptype = 'e'
    )
)
select
  r.function_name,
  r.dependency,
  r.provided_by,
  case
    when r.provided_by = 'pgcrypto' and exists (select 1 from pg_extension where extname = 'pgcrypto') then 'ok'
    when r.provided_by = 'pgcrypto (Supabase layout)' and exists (select 1 from pg_extension where extname = 'pgcrypto') then 'ok'
    when r.provided_by = 'pg_net' and exists (select 1 from pg_extension where extname = 'pg_net') then 'ok'
    when r.provided_by = 'pg_cron' and exists (select 1 from pg_extension where extname = 'pg_cron') then 'ok'
    when r.provided_by = 'supabase_vault' then 'MISSING (no vault on plain PostgreSQL)'
    else 'MISSING'
  end as status
from refs r
order by status desc, r.function_name, r.dependency;
