// Produce a disposable DB test from the actual deployed function definitions.
// Never point this output at production: fixtures create synthetic hosts/runs.
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const definition = (path, name) => {
  const match = read(path).match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\r?\\n\\$\\$;`));
  if (!match) throw new Error(`Missing function: ${name}`);
  return match[0];
};
const chunks = [
  "\\set ON_ERROR_STOP on",
  read("tests/cloud-monitor-fixture.sql"),
  "alter table public.hosts add column display_name text not null default 'Test Host';",
  read("supabase/migrations/202608130012_backup_center.sql"),
  read("supabase/migrations/202609070001_backup_restore_test_sla_read_model.sql"),
  definition("supabase/migrations/202608130021_notification_delivery_lifecycle.sql", "notification_channel_ready_v1"),
  definition("supabase/migrations/202608130022_notification_ordering_and_policy_retirement.sql", "notification_delivery_block_reason_v1"),
  definition("supabase/migrations/202608140007_reliability_burn_deescalation_suppression.sql", "claim_notification_outbox_v1"),
  read("supabase/migrations/20261025015453_backup_policy_lifecycle.sql"),
  read("tests/backup-age-pause-db.sql"),
  // Exercise the actual operator scripts, including main exclusion and rollback.
  `insert into public.hosts(id,server_id) values ('00000000-0000-4000-8000-000000000003','oci-minecraft-01');
   insert into public.backup_policies(host_id,backup_target,game_mode,backup_type)
   select '00000000-0000-4000-8000-000000000003', 'minecraft-'||mode, mode, 'full'
   from unnest(array['paper','skyblock','hardcore','gtnh','atm10','main']) mode;
   select (clock_timestamp()+interval '7 days')::text as pause_until \\gset
   \\set pause_reason 'Issue #138: operator script test'`,
  read("deploy/sql/backup-age-pause-prepare.sql"),
  `do $$ begin
    if (select count(*) from public.backup_policies where age_paused_until is not null)<>5
      or exists(select 1 from public.backup_policies where game_mode='main' and age_paused_until is not null)
      then raise exception 'operator scope regression'; end if;
  end; $$;`,
  read("deploy/sql/backup-age-pause-resume.sql"),
  `do $$ begin
    if exists(select 1 from public.backup_policies where age_paused_until is not null or not enabled)
      then raise exception 'operator resume regression'; end if;
  end; $$;
  \\echo 'Operator prepare/resume assertions passed'`,
];
process.stdout.write(chunks.join("\n").replace(/\r\n/g, "\n"));
