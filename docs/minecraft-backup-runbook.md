# Minecraft Backup Operations Runbook

Tracking: Issue #117. This runbook separates read-only checks, reviewed deployment and High Risk production actions.

## Routine health check

1. Confirm the timer and latest result:

   ```bash
   systemctl status mc-backup-s3.timer mc-backup-s3.service --no-pager -l
   journalctl -u mc-backup-s3.service --since '24 hours ago' --no-pager
   ```

2. Confirm the current server expectation before interpreting age:

   ```bash
   docker ps -a --format '{{.Names}}\t{{.Status}}'
   ```

3. List metadata only. Do not print archive contents or environment values:

   ```bash
   aws s3api list-objects-v2 \
     --bucket "$IVRM_BACKUP_BUCKET" \
     --prefix minecraft/ \
     --region ap-northeast-1 \
     --query 'Contents[].{Key:Key,Size:Size,LastModified:LastModified,StorageClass:StorageClass}'
   ```

4. In `/backups`, compare the exact policy, run ID, completion time and SLA. `sha256Verified`, `retentionExpiresAt` and `restoreTestedAt` are independent evidence fields.

## Stop a Minecraft target

Do not disable monitoring first.

1. Confirm maintenance approval and the target allowlist.
2. Run the backup service once and require exit code 0.
3. Confirm remote sync and `sha256Verified=true` for that exact run.
4. Stop the server through the approved lifecycle operation and verify it is stopped.
5. In a database transaction, select the exact policy row by host, target, game mode and type. Abort unless exactly one row matches.
6. Set only that row to `enabled=false`, commit, then verify the active Backup Age signal retired and undelivered alerts were suppressed as `backup_policy_disabled`.

Production policy changes require explicit approval. Never use a broad update by host alone.

Use a transaction and an exact policy ID copied from the immediately preceding read. Replace the placeholders locally; do not commit environment IDs:

```sql
begin;

select id, backup_target, game_mode, backup_type, enabled
from public.backup_policies
where host_id = '<approved-host-uuid>'::uuid
  and backup_target = '<approved-target>'
  and game_mode = '<approved-mode>'
  and backup_type = 'full'
for update;

update public.backup_policies
set enabled = false,
    updated_at = clock_timestamp()
where id = <exact-policy-id>
  and enabled
returning id, backup_target, game_mode, backup_type, enabled;

-- Commit only when both statements identify exactly one expected row.
commit;
```

If either statement returns zero or multiple rows, issue `rollback;` and investigate the target mapping.

## Start a stopped target

1. Re-enable the exact backup policy before starting the server.
2. Start through the approved lifecycle operation.
3. Verify Docker health, Minecraft login/handshake, TPS/MSPT and world/inventory state.
4. Run an immediate backup and verify remote checksum evidence.
5. Confirm the Backup Center target is enabled and within SLA.

If start fails, leave the final stopped-state artifact untouched. Disable the policy again only after the target is confirmed stopped and the operator records the rollback.

Re-enable with the same ID-locked transaction and `set enabled = true`. Do not upsert a replacement policy because it would create a second lifecycle identity.

## Deploy the hardened producer

Preconditions: merged commit SHA, CI Green, clean active backup job, free disk space, and a reviewed rollback copy.

1. Test from the checked-out immutable commit:

   ```bash
   python3 -m unittest deploy/oci/test_ivrm_backup_evidence.py
   python3 -m unittest deploy/oci/test_ivrm_backup_report_success.py
   bash deploy/oci/test_minecraft_backup_scripts.sh
   ```

2. Copy the four current production files to a root-owned rollback directory named with the UTC change timestamp.
3. Copy `deploy/oci/backup.env.example` to `/etc/ivrm-agent/backup.env`, replace the bucket placeholder locally, and keep it `root:root` mode `0600`. Install `mc-backup-s3-hardening.conf` as the systemd drop-in. Do not commit the production bucket identifier or credentials.
4. Install the reviewed files as:

   ```text
   deploy/oci/minecraft-backup.sh              -> /usr/local/bin/mc-backup
   deploy/oci/minecraft-backup-s3.sh           -> /usr/local/bin/mc-backup-s3
   deploy/oci/ivrm-backup-evidence.py           -> /usr/local/libexec/ivrm-backup-evidence
   deploy/oci/ivrm-backup-report-success.py     -> /usr/local/libexec/ivrm-backup-report-success
   deploy/oci/mc-backup-s3-hardening.conf       -> /etc/systemd/system/mc-backup-s3.service.d/hardening.conf
   ```

5. Preserve root ownership and existing executable modes. Do not modify `/etc/ivrm-agent/agent.env`.
6. Run one manual backup. Abort if sensitive-file validation, archive validation, S3 checksum verification or report submission fails.
7. Confirm no stale `*.pending` marker remains after successful report submission. A marker after failure must be retried, not deleted manually.
8. Confirm the latest artifact does not contain `.rcon-cli.env` or `.rcon-cli.yaml` by listing names only.
9. Observe the next scheduled run before closing the change.

Rollback: restore all four files from the same rollback directory, then run syntax/tests. Do not delete newly created safe artifacts during rollback.

## Isolated monthly restore test

1. Select a newly produced S3 Daily or Weekly artifact, or one whose stored evidence proves that `.rcon-cli.*`, `secrets/` and other forbidden paths are absent. Record key, version ID, size and checksum without exposing credentials. Historical artifacts without that proof remain metadata-only inventory and must not be downloaded or extracted.
2. Download into a new `mktemp -d` directory outside every production bind mount.
3. Run `ivrm-backup-evidence` and compare the expected SHA-256.
4. Extract only after path validation has passed.
5. Supply a reviewed `data/server.properties` template with fresh credentials; never copy this file from a historical archive.
6. Start with a dedicated compose project, no public route, no production RCON secret and no writable production mount.
7. Verify world load, clean log startup, representative player data/inventory and clean shutdown.
8. Record artifact SHA, source run ID, test time and result. Only then report `restoreTestedAt` against the tested policy.
9. Remove the isolated environment after retaining the non-secret evidence log.

## Potential credential exposure response

The October 24 audit found `.rcon-cli.env` and `.rcon-cli.yaml` names in several local archives. Their contents were not read.

1. Deploy and verify exclusions first.
2. Inventory affected current/Weekly/Monthly object keys without downloading or logging contents.
3. Rotate each affected RCON credential with target-specific approval; update server and permitted client atomically.
4. Verify RCON health without printing the credential.
5. Delete or quarantine affected historical objects only under a reviewed object/version manifest and rollback decision.

## Escalation and rollback triggers

Rollback or stop the change if world saves remain disabled, the archive contains a forbidden path, remote SHA evidence is absent, disk use exceeds the approved headroom, S3 retention removes more keys than planned, or Backup Center receives a false success.
