revoke all on table public.hosts from anon, authenticated;
revoke all on table public.agent_heartbeats from anon, authenticated;
revoke all on sequence public.agent_heartbeats_id_seq from anon, authenticated;

drop policy if exists "deny_public_hosts_access" on public.hosts;
create policy "deny_public_hosts_access"
on public.hosts
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists "deny_public_agent_heartbeats_access" on public.agent_heartbeats;
create policy "deny_public_agent_heartbeats_access"
on public.agent_heartbeats
as restrictive
for all
to anon, authenticated
using (false)
with check (false);
