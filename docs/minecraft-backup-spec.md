# Minecraft Backup Specification

Tracking: Issue #117

## Scope and ownership

This specification covers Minecraft world backups produced on `oci-minecraft-01`, copied to the private S3 backup bucket and reported to Backup Center. The live world directories remain the source data; S3 is the remote recovery boundary. Backup Center is evidence-only and never creates, deletes or restores an artifact.

## Target states

| Server state | Backup behavior | Backup Age policy |
| --- | --- | --- |
| running / writable | 03:00 and 15:00 JST, plus an operator-triggered pre-change run | enabled |
| transitioning to stopped | final save/flush, verified remote backup, then stop | enabled until final run is accepted |
| intentionally stopped / immutable | keep final verified artifact; do not create duplicate archives | disabled |
| transitioning to running | enable policy before start; run an immediate verified backup after health gate | enabled |
| decommissioned | move final evidence to the decommissioned class under separate approval | disabled |

`backup_policies.enabled=false` means that freshness monitoring is intentionally retired; it must never be used to hide a failed final backup. The existing database trigger retires active SLA signals and suppresses undelivered rows with `backup_policy_disabled`.

## Artifact contract

A successful archive must:

- be created atomically as `*.partial` and renamed only after `tar` succeeds;
- retain a `*.pending` marker until remote verification and Backup Center reporting both succeed, so partial multi-target failures are retried;
- contain at least one `level.dat` world marker;
- contain no absolute or parent-traversal paths;
- exclude runtime credentials, including `.rcon-cli.env`, `.rcon-cli.yaml`, and `secrets/`;
- pass gzip/tar parsing before upload;
- have a local SHA-256 calculated over the exact archive bytes;
- be uploaded with S3 SHA-256 checksum calculation enabled;
- have matching remote content length, a stored S3 checksum and matching `ivrm-sha256` source metadata before `sha256Verified=true` is reported.

If `save-off` succeeded, the job must confirm both `save-on` and a final save before success. A failed confirmation keeps the cleanup target registered for the EXIT retry and fails the service visibly.

Archive names are `minecraft-<mode>-YYYYMMDD-HHMMSS.tar.gz`. The reporter UUID remains deterministic for a given host and filename.

## Retention

Defaults proposed by the checked-in producer:

- local: latest 2 complete archives per server;
- S3 Daily: latest 14 explicit objects per server;
- Weekly: Sunday pre-noon copy;
- Monthly: first-day pre-noon copy.

Weekly and Monthly expiration remain controlled by reviewed S3 lifecycle rules. A count-based retention policy is not a precise expiry timestamp, so `retentionExpiresAt` remains null until a time-bound retention contract is configured and verified. Telemetry must not invent this value.

## Restore evidence

Structural archive validation is not a Restore Test. `restoreTestedAt` can be populated only after the selected artifact has been restored into an isolated path, started without production network/RCON exposure, reached a readable world state, shut down cleanly and had the temporary environment removed. The tested run ID and artifact SHA-256 must be recorded in the operator log.

## Alert semantics

Backup Age applies only to enabled policies. Running targets retain the existing 24-hour Warning and 48-hour Critical defaults unless an approved target-specific RPO changes them. Intentionally stopped targets are disabled only after their final verified backup. Re-enabling a server without re-enabling its policy is a failed start precondition.

## Security boundaries

- Backup logs, reports, issues and PRs must never contain credential values, bucket-internal presigned URLs or archive contents.
- Historical archives that may contain runtime credentials are treated as potentially sensitive. Inventory filenames and object metadata only.
- Credential rotation and historical-object deletion are separate High Risk production operations requiring exact approval.
- The backup IAM principal remains least privilege. Inability to read bucket encryption/public-access/object-lock configuration is reported as unknown, not assumed safe.
