create or replace function public.insert_agent_heartbeat(
  p_server_id text,
  p_agent_version text,
  p_sent_at timestamptz,
  p_request_nonce text,
  p_body_sha256 text,
  p_cpu_count integer,
  p_memory_total_bytes bigint,
  p_memory_available_bytes bigint,
  p_disk_total_bytes bigint,
  p_disk_available_bytes bigint,
  p_load_average_1 double precision,
  p_load_average_5 double precision,
  p_load_average_15 double precision,
  p_uptime_seconds double precision
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_host_id uuid;
  v_enabled boolean;
  v_latest_received_at timestamptz;
begin
  select id, enabled
  into v_host_id, v_enabled
  from public.hosts
  where server_id = p_server_id
  for update;

  if not found or not v_enabled then
    return 'unknown_agent';
  end if;

  select received_at
  into v_latest_received_at
  from public.agent_heartbeats
  where host_id = v_host_id
  order by received_at desc
  limit 1;

  if v_latest_received_at is not null
     and clock_timestamp() - v_latest_received_at < interval '8 seconds' then
    return 'rate_limited';
  end if;

  begin
    insert into public.agent_heartbeats (
      host_id,
      agent_version,
      received_at,
      sent_at,
      request_nonce,
      body_sha256,
      cpu_count,
      memory_total_bytes,
      memory_available_bytes,
      disk_total_bytes,
      disk_available_bytes,
      load_average_1,
      load_average_5,
      load_average_15,
      uptime_seconds
    ) values (
      v_host_id,
      p_agent_version,
      clock_timestamp(),
      p_sent_at,
      p_request_nonce,
      p_body_sha256,
      p_cpu_count,
      p_memory_total_bytes,
      p_memory_available_bytes,
      p_disk_total_bytes,
      p_disk_available_bytes,
      p_load_average_1,
      p_load_average_5,
      p_load_average_15,
      p_uptime_seconds
    );
  exception
    when unique_violation then
      return 'replayed_request';
  end;

  return 'accepted';
end;
$$;

revoke all on function public.insert_agent_heartbeat(
  text,
  text,
  timestamptz,
  text,
  text,
  integer,
  bigint,
  bigint,
  bigint,
  bigint,
  double precision,
  double precision,
  double precision,
  double precision
) from public, anon, authenticated;

grant execute on function public.insert_agent_heartbeat(
  text,
  text,
  timestamptz,
  text,
  text,
  integer,
  bigint,
  bigint,
  bigint,
  bigint,
  double precision,
  double precision,
  double precision,
  double precision
) to service_role;

comment on function public.insert_agent_heartbeat(
  text,
  text,
  timestamptz,
  text,
  text,
  integer,
  bigint,
  bigint,
  bigint,
  bigint,
  double precision,
  double precision,
  double precision,
  double precision
) is 'Host単位の行ロック内でレート制限確認とHeartbeat保存を原子的に行う';
