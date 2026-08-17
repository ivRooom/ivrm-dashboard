create index if not exists monitoring_events_sample_id_idx
  on public.monitoring_events (sample_id);

create index if not exists host_monitoring_events_heartbeat_id_idx
  on public.host_monitoring_events (heartbeat_id);

drop policy if exists "deny_observability_retention_state_public_access"
  on public.observability_retention_state;
create policy "deny_observability_retention_state_public_access"
on public.observability_retention_state
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

comment on index public.monitoring_events_sample_id_idx is
  'Container Sample Retention時のmonitoring_events外部キー参照確認を高速化する。';
comment on index public.host_monitoring_events_heartbeat_id_idx is
  'Heartbeat Retention時のhost_monitoring_events外部キー参照確認を高速化する。';