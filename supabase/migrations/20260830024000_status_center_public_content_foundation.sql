create or replace function public.status_service_ids_valid_v1(p_service_ids text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    p_service_ids is not null
    and cardinality(p_service_ids) between 1 and 32
    and not exists (
      select 1
      from unnest(p_service_ids) as service_id
      where service_id is null
        or char_length(service_id) not between 3 and 64
        or service_id !~ '^[a-z0-9][a-z0-9-]{2,63}$'
    )
    and cardinality(p_service_ids) = (
      select count(distinct service_id)
      from unnest(p_service_ids) as service_id
    );
$$;

revoke all on function public.status_service_ids_valid_v1(text[])
  from public, anon, authenticated, service_role;

create table public.status_incidents (
  id uuid primary key default gen_random_uuid(),
  public_id text not null default (
    'INC-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
  ),
  title text not null,
  lifecycle_status text not null default 'investigating',
  impact text not null,
  affected_service_ids text[] not null,
  source_type text not null default 'manual',
  source_ref text,
  started_at timestamptz not null,
  resolved_at timestamptz,
  summary text not null,
  publication_state text not null default 'draft',
  published_at timestamptz,
  create_request_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint status_incidents_public_id_key unique (public_id),
  constraint status_incidents_create_request_key unique (create_request_id),
  constraint status_incidents_public_id_check check (
    public_id ~ '^INC-[A-F0-9]{12}$'
  ),
  constraint status_incidents_title_check check (
    char_length(title) between 1 and 160
    and title = btrim(title)
  ),
  constraint status_incidents_lifecycle_check check (
    lifecycle_status in ('investigating', 'identified', 'monitoring', 'resolved')
  ),
  constraint status_incidents_impact_check check (
    impact in ('none', 'minor', 'major', 'critical')
  ),
  constraint status_incidents_services_check check (
    public.status_service_ids_valid_v1(affected_service_ids)
  ),
  constraint status_incidents_source_check check (
    source_type in ('automatic', 'manual')
  ),
  constraint status_incidents_source_ref_check check (
    source_ref is null
    or (
      char_length(source_ref) between 1 and 255
      and source_ref = btrim(source_ref)
    )
  ),
  constraint status_incidents_summary_check check (
    char_length(summary) between 1 and 2000
    and summary = btrim(summary)
  ),
  constraint status_incidents_publication_check check (
    publication_state in ('draft', 'published', 'archived')
  ),
  constraint status_incidents_publish_time_check check (
    (publication_state = 'draft' and published_at is null)
    or (publication_state in ('published', 'archived') and published_at is not null)
  ),
  constraint status_incidents_resolution_check check (
    (lifecycle_status = 'resolved' and resolved_at is not null and resolved_at >= started_at)
    or (lifecycle_status <> 'resolved' and resolved_at is null)
  ),
  constraint status_incidents_time_check check (updated_at >= created_at)
);

create index status_incidents_publication_updated_idx
  on public.status_incidents (publication_state, updated_at desc);
create index status_incidents_started_idx
  on public.status_incidents (started_at desc);
create index status_incidents_active_idx
  on public.status_incidents (impact, started_at desc)
  where publication_state = 'published' and lifecycle_status <> 'resolved';
create index status_incidents_services_gin_idx
  on public.status_incidents using gin (affected_service_ids);

create table public.status_incident_updates (
  id bigint generated always as identity primary key,
  incident_id uuid not null references public.status_incidents(id) on delete restrict,
  lifecycle_status text not null,
  message text not null,
  published_at timestamptz not null,
  request_id uuid not null,
  created_at timestamptz not null default now(),
  constraint status_incident_updates_request_key unique (request_id),
  constraint status_incident_updates_lifecycle_check check (
    lifecycle_status in ('investigating', 'identified', 'monitoring', 'resolved')
  ),
  constraint status_incident_updates_message_check check (
    char_length(message) between 1 and 2000
    and message = btrim(message)
  ),
  constraint status_incident_updates_publish_time_check check (
    published_at <= created_at + interval '5 minutes'
  )
);

create index status_incident_updates_incident_published_idx
  on public.status_incident_updates (incident_id, published_at asc, id asc);

create table public.status_maintenance_notices (
  id uuid primary key default gen_random_uuid(),
  public_id text not null default (
    'MNT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
  ),
  title text not null,
  body text not null,
  affected_service_ids text[] not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  publication_state text not null default 'draft',
  published_at timestamptz,
  cancelled_at timestamptz,
  reliability_window_id uuid references public.reliability_maintenance_windows(id) on delete set null,
  create_request_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint status_maintenance_notices_public_id_key unique (public_id),
  constraint status_maintenance_notices_create_request_key unique (create_request_id),
  constraint status_maintenance_notices_public_id_check check (
    public_id ~ '^MNT-[A-F0-9]{12}$'
  ),
  constraint status_maintenance_notices_title_check check (
    char_length(title) between 1 and 160
    and title = btrim(title)
  ),
  constraint status_maintenance_notices_body_check check (
    char_length(body) between 1 and 4000
    and body = btrim(body)
  ),
  constraint status_maintenance_notices_services_check check (
    public.status_service_ids_valid_v1(affected_service_ids)
  ),
  constraint status_maintenance_notices_time_check check (
    ends_at > starts_at
    and ends_at <= starts_at + interval '14 days'
    and updated_at >= created_at
  ),
  constraint status_maintenance_notices_publication_check check (
    publication_state in ('draft', 'published', 'cancelled')
  ),
  constraint status_maintenance_notices_publish_time_check check (
    (publication_state = 'draft' and published_at is null and cancelled_at is null)
    or (publication_state = 'published' and published_at is not null and cancelled_at is null)
    or (publication_state = 'cancelled' and published_at is not null and cancelled_at is not null)
  ),
  constraint status_maintenance_notices_cancel_time_check check (
    cancelled_at is null or cancelled_at >= created_at
  )
);

create index status_maintenance_notices_publication_start_idx
  on public.status_maintenance_notices (publication_state, starts_at desc);
create index status_maintenance_notices_schedule_idx
  on public.status_maintenance_notices (starts_at, ends_at)
  where publication_state = 'published';
create index status_maintenance_notices_services_gin_idx
  on public.status_maintenance_notices using gin (affected_service_ids);
create index status_maintenance_notices_reliability_window_idx
  on public.status_maintenance_notices (reliability_window_id)
  where reliability_window_id is not null;

create table public.status_announcements (
  id uuid primary key default gen_random_uuid(),
  public_id text not null default (
    'ANN-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
  ),
  kind text not null,
  title text not null,
  body text not null,
  affected_service_ids text[],
  publish_at timestamptz not null,
  expires_at timestamptz,
  publication_state text not null default 'draft',
  published_at timestamptz,
  archived_at timestamptz,
  create_request_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint status_announcements_public_id_key unique (public_id),
  constraint status_announcements_create_request_key unique (create_request_id),
  constraint status_announcements_public_id_check check (
    public_id ~ '^ANN-[A-F0-9]{12}$'
  ),
  constraint status_announcements_kind_check check (
    kind in ('info', 'warning')
  ),
  constraint status_announcements_title_check check (
    char_length(title) between 1 and 160
    and title = btrim(title)
  ),
  constraint status_announcements_body_check check (
    char_length(body) between 1 and 4000
    and body = btrim(body)
  ),
  constraint status_announcements_services_check check (
    affected_service_ids is null
    or public.status_service_ids_valid_v1(affected_service_ids)
  ),
  constraint status_announcements_expiry_check check (
    expires_at is null or expires_at > publish_at
  ),
  constraint status_announcements_publication_check check (
    publication_state in ('draft', 'published', 'archived')
  ),
  constraint status_announcements_publish_time_check check (
    (publication_state = 'draft' and published_at is null and archived_at is null)
    or (publication_state = 'published' and published_at is not null and archived_at is null)
    or (publication_state = 'archived' and published_at is not null and archived_at is not null)
  ),
  constraint status_announcements_update_time_check check (updated_at >= created_at)
);

create index status_announcements_publication_publish_idx
  on public.status_announcements (publication_state, publish_at desc);
create index status_announcements_active_idx
  on public.status_announcements (publish_at, expires_at)
  where publication_state = 'published';
create index status_announcements_services_gin_idx
  on public.status_announcements using gin (affected_service_ids)
  where affected_service_ids is not null;

alter table public.status_incidents enable row level security;
alter table public.status_incidents force row level security;
alter table public.status_incident_updates enable row level security;
alter table public.status_incident_updates force row level security;
alter table public.status_maintenance_notices enable row level security;
alter table public.status_maintenance_notices force row level security;
alter table public.status_announcements enable row level security;
alter table public.status_announcements force row level security;

revoke all on table public.status_incidents
  from public, anon, authenticated, service_role;
revoke all on table public.status_incident_updates
  from public, anon, authenticated, service_role;
revoke all on table public.status_maintenance_notices
  from public, anon, authenticated, service_role;
revoke all on table public.status_announcements
  from public, anon, authenticated, service_role;
revoke all on sequence public.status_incident_updates_id_seq
  from public, anon, authenticated, service_role;

create or replace function public.prevent_status_incident_update_mutation_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'status_incident_updates_are_append_only' using errcode = '42501';
end;
$$;

revoke all on function public.prevent_status_incident_update_mutation_v1()
  from public, anon, authenticated, service_role;

create trigger status_incident_updates_immutable
before update or delete on public.status_incident_updates
for each row execute function public.prevent_status_incident_update_mutation_v1();

create or replace function public.get_status_public_feed_v1(
  p_since timestamptz default (now() - interval '365 days'),
  p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_since timestamptz;
  v_limit integer;
  v_incidents jsonb;
  v_maintenance jsonb;
  v_announcements jsonb;
begin
  v_since := greatest(
    coalesce(p_since, v_now - interval '365 days'),
    v_now - interval '10 years'
  );
  v_limit := least(greatest(coalesce(p_limit, 200), 1), 500);

  select coalesce(jsonb_agg(item order by sort_at desc), '[]'::jsonb)
    into v_incidents
  from (
    select
      jsonb_build_object(
        'publicId', i.public_id,
        'title', i.title,
        'status', i.lifecycle_status,
        'impact', i.impact,
        'affectedServiceIds', to_jsonb(i.affected_service_ids),
        'startedAt', i.started_at,
        'resolvedAt', i.resolved_at,
        'updatedAt', i.updated_at,
        'summary', i.summary,
        'source', i.source_type,
        'updates', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'status', u.lifecycle_status,
              'message', u.message,
              'publishedAt', u.published_at
            ) order by u.published_at asc, u.id asc
          )
          from public.status_incident_updates u
          where u.incident_id = i.id
        ), '[]'::jsonb)
      ) as item,
      i.updated_at as sort_at
    from public.status_incidents i
    where i.publication_state = 'published'
      and (i.updated_at >= v_since or i.lifecycle_status <> 'resolved')
    order by i.updated_at desc, i.id desc
    limit v_limit
  ) q;

  select coalesce(jsonb_agg(item order by sort_at desc), '[]'::jsonb)
    into v_maintenance
  from (
    select
      jsonb_build_object(
        'publicId', m.public_id,
        'title', m.title,
        'summary', m.body,
        'affectedServiceIds', to_jsonb(m.affected_service_ids),
        'startsAt', m.starts_at,
        'endsAt', m.ends_at,
        'state', case
          when m.publication_state = 'cancelled' then 'cancelled'
          when v_now < m.starts_at then 'scheduled'
          when v_now < m.ends_at then 'in_progress'
          else 'completed'
        end,
        'updatedAt', m.updated_at
      ) as item,
      m.updated_at as sort_at
    from public.status_maintenance_notices m
    where m.publication_state in ('published', 'cancelled')
      and (m.updated_at >= v_since or (m.starts_at <= v_now and m.ends_at >= v_now))
    order by m.updated_at desc, m.id desc
    limit v_limit
  ) q;

  select coalesce(jsonb_agg(item order by sort_at desc), '[]'::jsonb)
    into v_announcements
  from (
    select
      jsonb_build_object(
        'publicId', a.public_id,
        'kind', a.kind,
        'title', a.title,
        'body', a.body,
        'affectedServiceIds', case
          when a.affected_service_ids is null then '[]'::jsonb
          else to_jsonb(a.affected_service_ids)
        end,
        'publishedAt', a.publish_at,
        'expiresAt', a.expires_at,
        'active', (
          a.publication_state = 'published'
          and a.publish_at <= v_now
          and (a.expires_at is null or a.expires_at > v_now)
        )
      ) as item,
      a.publish_at as sort_at
    from public.status_announcements a
    where a.publication_state in ('published', 'archived')
      and a.publish_at <= v_now
      and a.publish_at >= v_since
    order by a.publish_at desc, a.id desc
    limit v_limit
  ) q;

  return jsonb_build_object(
    'schemaVersion', '1.0',
    'generatedAt', v_now,
    'incidents', v_incidents,
    'maintenance', v_maintenance,
    'announcements', v_announcements
  );
end;
$$;

revoke all on function public.get_status_public_feed_v1(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.get_status_public_feed_v1(timestamptz, integer)
  to service_role;

create or replace function public.get_status_center_overview_v1(
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
  v_incidents jsonb;
  v_maintenance jsonb;
  v_announcements jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(q) order by q.updated_at desc), '[]'::jsonb)
    into v_incidents
  from (
    select
      i.public_id,
      i.title,
      i.lifecycle_status,
      i.impact,
      i.affected_service_ids,
      i.source_type,
      i.started_at,
      i.resolved_at,
      i.summary,
      i.publication_state,
      i.published_at,
      i.created_at,
      i.updated_at
    from public.status_incidents i
    order by i.updated_at desc, i.id desc
    limit v_limit
  ) q;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.updated_at desc), '[]'::jsonb)
    into v_maintenance
  from (
    select
      m.public_id,
      m.title,
      m.body,
      m.affected_service_ids,
      m.starts_at,
      m.ends_at,
      m.publication_state,
      m.published_at,
      m.cancelled_at,
      m.reliability_window_id,
      m.created_at,
      m.updated_at
    from public.status_maintenance_notices m
    order by m.updated_at desc, m.id desc
    limit v_limit
  ) q;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.updated_at desc), '[]'::jsonb)
    into v_announcements
  from (
    select
      a.public_id,
      a.kind,
      a.title,
      a.body,
      a.affected_service_ids,
      a.publish_at,
      a.expires_at,
      a.publication_state,
      a.published_at,
      a.archived_at,
      a.created_at,
      a.updated_at
    from public.status_announcements a
    order by a.updated_at desc, a.id desc
    limit v_limit
  ) q;

  return jsonb_build_object(
    'generatedAt', now(),
    'incidents', v_incidents,
    'maintenance', v_maintenance,
    'announcements', v_announcements
  );
end;
$$;

revoke all on function public.get_status_center_overview_v1(integer)
  from public, anon, authenticated;
grant execute on function public.get_status_center_overview_v1(integer)
  to service_role;

comment on table public.status_incidents is
  'Public-facing incident CMS records. Internal monitoring details stay outside this table; only intentionally publishable summaries belong here.';
comment on table public.status_incident_updates is
  'Append-only public incident update timeline. Published history is immutable.';
comment on table public.status_maintenance_notices is
  'Public maintenance notices. Reliability SLO exclusion windows remain a separate responsibility and may be linked by UUID.';
comment on table public.status_announcements is
  'Scheduled public status-page announcements. Initial content is plain text and never arbitrary HTML.';
comment on function public.get_status_public_feed_v1(timestamptz, integer) is
  'Returns the sanitized public Status Portal CMS feed for server-to-server consumption. Internal UUIDs, source references, actor identity, credentials, and audit metadata are intentionally omitted.';
comment on function public.get_status_center_overview_v1(integer) is
  'Returns bounded Status Center administration rows to the server-side console without granting direct table access.';