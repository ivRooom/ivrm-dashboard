-- get_status_center_summary_v1: the status center summary used by the
-- ivrm-web API (Admin status overview). This function existed only in
-- Supabase and was missed by the PG17 port (C-d1); the console does not
-- use it, so the gap surfaced only when the API was rewired (C-d4).
-- It was applied directly to PG17 ivrm_dashboard on 2026-11-11 during
-- C-d4 (owner set to ivrm_dashboard_owner); this migration records the
-- definition in the repository. The body is the Supabase original,
-- unchanged.

CREATE OR REPLACE FUNCTION public.get_status_center_summary_v1()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'generatedAt', now(),
    'activeIncidents', (
      select count(*)
      from public.status_incidents i
      where i.publication_state = 'published'
        and i.lifecycle_status <> 'resolved'
    ),
    'maintenance', (
      select count(*)
      from public.status_maintenance_notices m
      where m.publication_state = 'published'
        and m.cancelled_at is null
        and m.ends_at > now()
    ),
    'publishedAnnouncements', (
      select count(*)
      from public.status_announcements a
      where a.publication_state = 'published'
        and a.archived_at is null
        and a.publish_at <= now()
        and (a.expires_at is null or a.expires_at > now())
    ),
    'drafts', (
      (select count(*) from public.status_incidents i where i.publication_state = 'draft')
      + (select count(*) from public.status_maintenance_notices m where m.publication_state = 'draft')
      + (select count(*) from public.status_announcements a where a.publication_state = 'draft')
    )
  );
$function$;

GRANT EXECUTE ON FUNCTION public.get_status_center_summary_v1() TO PUBLIC, ivrm_dashboard_runtime, ivrm_dashboard_service, ivrm_dashboard_authenticator;
