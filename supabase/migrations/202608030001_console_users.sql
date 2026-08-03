create table if not exists public.console_users (
  id uuid primary key default gen_random_uuid(),
  access_subject text not null,
  email text not null,
  display_name text,
  role text not null default 'viewer',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint console_users_access_subject_check check (
    char_length(access_subject) between 1 and 255
    and access_subject = btrim(access_subject)
  ),
  constraint console_users_email_check check (
    char_length(email) between 3 and 320
    and email = lower(btrim(email))
  ),
  constraint console_users_display_name_check check (
    display_name is null
    or (
      char_length(display_name) between 1 and 120
      and display_name = btrim(display_name)
    )
  ),
  constraint console_users_role_check check (
    role in ('viewer', 'operator', 'administrator', 'owner')
  )
);

create unique index if not exists console_users_access_subject_key
  on public.console_users (access_subject);

create unique index if not exists console_users_email_lower_key
  on public.console_users (lower(email));

create index if not exists console_users_active_role_idx
  on public.console_users (is_active, role);

alter table public.console_users enable row level security;
alter table public.console_users force row level security;

revoke all on table public.console_users from public;
revoke all on table public.console_users from anon;
revoke all on table public.console_users from authenticated;

grant all on table public.console_users to service_role;

comment on table public.console_users is
  'Cloudflare Access identityとWebコンソールRBACを管理する。Minecraft LuckPermsとは別管理。';
comment on column public.console_users.access_subject is
  '検証済みCloudflare Access JWTのsub。生JWTは保存しない。';
comment on column public.console_users.role is
  'viewer / operator / administrator / ownerのWebコンソールロール。';
