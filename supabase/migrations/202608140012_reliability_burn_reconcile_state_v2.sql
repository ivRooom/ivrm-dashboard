-- Phase 4 hardening: expose the reconciler state update timestamp so the UI can
-- distinguish a short first-run grace period from a permanently non-running cron.
-- Keep v1 intact for backward compatibility.

create or replace function public.get_reliability_burn_reconcile_state_v2()
returns table (
  enabled boolean,
  endpoint_configured boolean,
  state_updated_at timestamptz,
  last_invoked_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error_code text,
  last_evaluated_count integer
)
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select
    state.enabled,
    state.endpoint_url is not null,
    state.updated_at,
    state.last_invoked_at,
    state.last_success_at,
    state.last_error_at,
    state.last_error_code,
    state.last_evaluated_count
  from public.reliability_burn_reconcile_state as state
  where state.id = 1;
$$;

revoke all on function public.get_reliability_burn_reconcile_state_v2()
  from public, anon, authenticated;
grant execute on function public.get_reliability_burn_reconcile_state_v2()
  to service_role;

comment on function public.get_reliability_burn_reconcile_state_v2() is
  'Returns Burn Reconciler operational state including state_updated_at, used to escalate an enabled reconciler that never invokes after its startup grace period.';
