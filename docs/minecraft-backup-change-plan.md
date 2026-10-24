# Minecraft Backup Hardening Change Plan

## Purpose

Eliminate false Critical age alerts for intentionally stopped targets, prevent runtime credential files from entering new archives, add remote checksum evidence, improve short-term recovery depth and document restore operations.

## Risk

High Risk when applied: production infrastructure, backup retention/cost, monitoring policy flags, credential rotation and possible historical-object deletion. This repository change alone does not apply any production mutation.

## Affected systems

- OCI `oci-minecraft-01`: backup producer, S3 uploader and reporter helper;
- S3 Minecraft backup prefixes and storage cost;
- Supabase `backup_policies` and Notification Center lifecycle;
- Discord notifications derived from Backup Center;
- Minecraft RCON credentials if rotation is approved.

## Deployment waves

1. Merge source, tests, specification and runbook.
2. Deploy secret exclusions, atomic archive creation and evidence validation.
3. Produce and validate a new safe `minecraft-main` artifact.
4. With separate approval, disable the exact GTNH and ATM10 policies while those servers remain stopped.
5. Observe scheduled runs and notification recovery.
6. With separate approval, rotate affected RCON credentials.
7. After an object/version inventory and reviewed manifest, quarantine or remove historical sensitive archives.
8. Perform an isolated restore rehearsal and report only real evidence.

## Validation

- Python unit tests for archive path/sensitive-name/checksum evidence;
- shell syntax and contract tests for producer/uploader defaults;
- latest local archive and S3 HeadObject size/checksum/source-hash agreement;
- Backup Center exact run fields;
- no active age signal for disabled stopped policies;
- next scheduled job succeeds;
- isolated restore reaches readable world state.

## Rollback

- Restore the four prior root-owned executables and the systemd drop-in from the change-specific rollback directory. If the drop-in did not previously exist, remove the newly installed drop-in and run `systemctl daemon-reload`.
- Restore prior policy `enabled` values only if the corresponding runtime expectation is still correct.
- Keep new safe artifacts; do not restore credential-containing archives as current.
- Stop further credential/object operations if any target mapping is ambiguous.

## Current unknowns / approvals

- Bucket encryption, Public Access Block, Object Lock and Replication were not readable by the backup IAM principal.
- Exact RCON secrets and affected S3 versions were intentionally not inspected.
- Production script installation, policy changes, credential rotation and object deletion each require a target-specific approval and audit record.
