-- Disposable local PostgreSQL only.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
end $$;
create table public.hosts(server_id text unique not null, enabled boolean not null);
insert into public.hosts values('aws-app-01',true),('lightsail-herta',false);
