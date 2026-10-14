-- Runtime inventory does not imply 30-second heartbeat monitoring.
alter table public.hosts add column runtime_inventory_enabled boolean not null default false;
comment on column public.hosts.runtime_inventory_enabled is 'Explicit runtime inventory enrollment, independent of legacy heartbeat monitoring';

create or replace function public.ingest_runtime_inventory_v1(p_server_id text,p_observed_at timestamptz,p_nonce text,p_containers jsonb)
returns text language plpgsql security definer set search_path=pg_catalog,public as $$
declare expected text[]; item jsonb; previous public.runtime_inventory%rowtype;
begin
  expected := case p_server_id
    when 'aws-app-01' then array['ivrm-admin','ivrm-api','ivrm-home','ivrm-member','ivrm-contact','ivrm-cloudflared','ivrm-runtime-caddy','ivrm-runtime-health']
    when 'lightsail-herta' then array['herta-api-1','herta-studio-1','herta-worker-1','herta-bot-1','herta-postgres-1','herta-redis-1','herta-caddy-1','herta-nginx-1']
    when 'oci-minecraft-01' then array['mc-main','ivrm-velocity','mc-resource-router','ivrm-status-api','caddy']
    else null end;
  if expected is null then return 'target_not_allowed'; end if;
  perform 1 from public.hosts where server_id=p_server_id and runtime_inventory_enabled for update;
  if not found then return 'unknown_agent'; end if;
  if p_nonce is null or p_nonce !~ '^[a-f0-9]{32}$' or p_observed_at is null
    or p_observed_at < clock_timestamp()-interval '5 minutes' or p_observed_at > clock_timestamp()+interval '30 seconds'
    or p_containers is null or jsonb_typeof(p_containers)<>'array' or octet_length(p_containers::text)>30000 then return 'invalid_payload'; end if;
  if jsonb_array_length(p_containers)<>cardinality(expected) then return 'invalid_payload'; end if;
  if (select count(distinct value->>'name') from jsonb_array_elements(p_containers))<>cardinality(expected) then return 'invalid_payload'; end if;
  for item in select value from jsonb_array_elements(p_containers) loop
    if jsonb_typeof(item) is distinct from 'object' then return 'invalid_payload'; end if;
    if (item->>'name'=any(expected)) is distinct from true then return 'target_not_allowed'; end if;
    if item->>'collection'='unavailable' then
      if (select count(*) from jsonb_object_keys(item))<>2 then return 'invalid_payload'; end if;
    elsif item->>'collection'='ok' then
      if (select count(*) from jsonb_object_keys(item))<>9
        or not item ?& array['name','collection','state','health','restartCount','oomKilled','exitCode','image','imageId']
        or (item->>'state' in ('created','running','paused','restarting','removing','exited','dead')) is distinct from true
        or (item->>'health' in ('starting','healthy','unhealthy','none')) is distinct from true
        or jsonb_typeof(item->'oomKilled') is distinct from 'boolean'
        or jsonb_typeof(item->'restartCount') is distinct from 'number' or (item->>'restartCount' ~ '^[0-9]{1,10}$') is distinct from true
        or jsonb_typeof(item->'exitCode') is distinct from 'number' or (item->>'exitCode' ~ '^[0-9]{1,3}$') is distinct from true
        or jsonb_typeof(item->'image') is distinct from 'string' or (item->>'image' ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,254}$') is distinct from true
        or jsonb_typeof(item->'imageId') is distinct from 'string' or (item->>'imageId' ~ '^sha256:[0-9a-f]{64}$') is distinct from true then return 'invalid_payload'; end if;
      if (item->>'restartCount')::bigint>2147483647 or (item->>'exitCode')::integer>255 then return 'invalid_payload'; end if;
    else return 'invalid_payload'; end if;
  end loop;
  select * into previous from public.runtime_inventory where server_id=p_server_id;
  if found then
    if p_nonce=previous.nonce or p_observed_at<=previous.observed_at then return 'replayed_request'; end if;
    if previous.received_at>clock_timestamp()-interval '15 seconds' then return 'rate_limited'; end if;
  end if;
  insert into public.runtime_inventory(server_id,observed_at,nonce,containers) values(p_server_id,p_observed_at,p_nonce,p_containers)
    on conflict(server_id) do update set observed_at=excluded.observed_at,received_at=clock_timestamp(),nonce=excluded.nonce,containers=excluded.containers;
  return 'accepted';
end $$;
revoke all on function public.ingest_runtime_inventory_v1(text,timestamptz,text,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_runtime_inventory_v1(text,timestamptz,text,jsonb) to service_role;
