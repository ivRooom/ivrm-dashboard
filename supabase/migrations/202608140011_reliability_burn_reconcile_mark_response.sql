-- Production hotfix: the Next.js RPC helper always parses successful RPC bodies as JSON.
-- mark_reliability_burn_reconcile_v1 previously returned void, so PostgREST replied with
-- an empty body and response.json() raised after the state update had already succeeded.
-- Recreate the same signature with a boolean result so existing Phase 3 code receives JSON true.

drop function public.mark_reliability_burn_reconcile_v1(boolean, integer, text);

create function public.mark_reliability_burn_reconcile_v1(
  p_success boolean,
  p_evaluated_count integer,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_success is null
    or p_evaluated_count is null or p_evaluated_count < 0 or p_evaluated_count > 4
    or (p_error_code is not null and char_length(p_error_code) > 128) then
    raise exception 'reliability_burn_reconcile_state_invalid' using errcode = '22023';
  end if;

  update public.reliability_burn_reconcile_state
  set last_invoked_at = clock_timestamp(),
      last_success_at = case when p_success then clock_timestamp() else last_success_at end,
      last_error_at = case when p_success then null else clock_timestamp() end,
      last_error_code = case when p_success then null else coalesce(p_error_code, 'unknown_error') end,
      last_evaluated_count = p_evaluated_count,
      updated_at = clock_timestamp()
  where id = 1;

  if not found then
    raise exception 'reliability_burn_reconcile_state_missing' using errcode = '55000';
  end if;

  return true;
end;
$$;

revoke all on function public.mark_reliability_burn_reconcile_v1(boolean, integer, text)
  from public, anon, authenticated;
grant execute on function public.mark_reliability_burn_reconcile_v1(boolean, integer, text)
  to service_role;

comment on function public.mark_reliability_burn_reconcile_v1(boolean, integer, text) is
  'Updates Burn Reconciler state and returns JSON-compatible true so server RPC callers can safely parse the successful response.';
