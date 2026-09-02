# mc-main Safe Lifecycle Execution Bridge (Issue #68 Phase B-1)

## Scope

Phase B-1 connects only the fixed `mc-main` lifecycle actions:

- `start_backend`: operator or higher, no confirmation phrase
- `restart_backend`: operator or higher, exact confirmation `RESTART`
- `stop_backend`: administrator or owner, exact confirmation `STOP`

`restart_proxy`, backup/maintenance mutations, mode switching, Minecraft commands, arbitrary Shell, arbitrary Docker and arbitrary RCON remain out of scope.

## Security boundary

```text
Browser / Discord Session
  -> POST /api/operations/jobs
  -> operation_jobs / operation_events / hash-chain audit_logs
  -> HMAC / timestamp / nonce protected Agent claim
  -> non-root ivrm-operation-worker
  -> owner-only request IPC under /run/ivrm-agent/operations
  -> root-owned fixed ivrm-mc-main-lifecycle helper
  -> /usr/bin/docker inspect|start|kill --signal=TERM mc-main
```

The Browser never supplies a container name, systemd unit, raw command, Docker argv or RCON input. Web and Agent both allowlist the server/action. The root helper has `mc-main` and the three actions compiled into the implementation.

Lifecycle mutation is intentionally restricted to an authenticated Discord Session even when Cloudflare Access is available for read-only console access. Agent endpoints are fixed to `https://console.ivrm.jp`, reject redirects, and use HMAC/timestamp/nonce replay protection.

The request directory is owned by the dedicated `ivrm-agent` user with mode `0700`; request files are `0600` and are rejected when stale or group/other-accessible. Result files are root-owned and readable, but not writable, by the worker group.

## Safety gates

Both gates default to `false` and are independent:

- Vercel: `IVRM_OPERATION_REQUESTS_ENABLED=false`
- OCI: `/etc/ivrm-agent/operation.env` -> `IVRM_OPERATION_EXECUTION_ENABLED=false`

`stage-mc-main-lifecycle.sh` always resets OCI execution to `false`. Merge, Web deploy, Supabase migration and OCI stage alone therefore do not execute a Minecraft lifecycle action.

## Lifecycle semantics

### Start

1. Inspect fixed `mc-main`.
2. Already `running + healthy` is idempotent success.
3. A pre-existing running but unhealthy container fails closed.
4. Otherwise run fixed `docker start mc-main`.
5. Require `running + healthy` within 120 seconds.

### Stop

1. Inspect fixed `mc-main`.
2. Already stopped/nonexistent is idempotent success.
3. Send fixed `SIGTERM` to `mc-main`.
4. Wait up to 60 seconds for stopped state.
5. **Never escalate automatically to SIGKILL.** Timeout is a failed operation requiring manual investigation.

### Restart

Graceful stop must succeed before start is attempted. The final Health Gate is identical to Start. The Agent lease is 300 seconds and the IPC result timeout defaults to 225 seconds and is capped at 240 seconds, leaving lease margin for the terminal transition.

### Worker restart recovery

A worker restart does not automatically execute the action again. The claim RPC first returns an unexpired `leased`/`running` Job already owned by the same lease owner and renews that lease. A recovered `running` Job consumes the existing request/result IPC evidence. IPC evidence is retained until the terminal DB transition succeeds. If the expected recovery evidence is missing, the worker fails closed with `recovery_state_missing` instead of replaying the lifecycle action.

## Rollout order

1. Merge only after Web/Agent CI, ARM64/AMD64 builds, HMAC tests, helper tests and stage non-interference tests pass.
2. Deploy Web with `IVRM_OPERATION_REQUESTS_ENABLED=false`.
3. Apply Phase B-1 Supabase migrations.
4. Run the rollback-only DB contract test and confirm Operation active job count is zero.
5. Stage OCI with `stage-mc-main-lifecycle.sh`; verify execution remains OFF and no Minecraft/Agent restart occurred.
6. Confirm `mc-main` is `running / healthy`, restart count stable, OOM=false, current backup available and restore procedure known.
7. Enable OCI execution first while Browser requests remain OFF. Confirm worker/helper health without creating jobs.
8. Enable Browser requests.
9. Acceptance order should minimize risk: idempotent `start_backend` while already healthy -> controlled `restart_backend` -> `stop_backend` only in an explicit maintenance window.
10. After every operation verify Operation state, audit chain, `/logs?source=mc-main`, Docker health and Minecraft backend/public ping.

## Rollback

Non-destructive rollback is to set both gates to `false`. This prevents new Browser jobs and prevents the worker from claiming/executing lifecycle jobs.

If a queued job exists, keep OCI execution OFF and investigate/cancel through the Operation state machine rather than editing DB rows directly. If restart/start fails Health Gate, do not loop retries automatically; inspect read-only logs and current container state first.

## Data / audit rules

Operation payload is fixed `{}`. Audit/Job metadata is limited to safe action/status/phase/error-code fields. Secret, token, password, private IP, raw command, container inspection output and RCON material must never be persisted or rendered. Denied requests use a null `operation_job` target ID because no Job exists yet; the Discord user ID is recorded only as bounded audit metadata.

## Production acceptance status — 2026-09-03

Phase B-1 implementation and the first Production execution path are complete.

### Deployed implementation

- PR #112: Safe Lifecycle Execution Bridge
- PR #113: Production rollback-only contractで検出した`claim_mc_main_operation_job`のPL/pgSQL列名衝突をadditive migrationで修正
- PR #114: OCI Production hostのPython 3.9互換性を修正し、Agent CIもPython 3.9へ固定
- PR #115: `/operations`でBrowser request gateのON状態を明示
- Supabase Phase B-1 migration / transition bridge / claim ambiguity fixはProduction適用済み
- rollback-only DB contractはProductionで成功し、active Jobを残していない
- OCI stageはPython 3.9.25 hostで成功し、stage中はexecution OFFのままMinecraft lifecycle actionを実行していない
- OCI execution gate有効化後、Operation Workerからclaim endpointへの定期pollを確認
- Browser request gate有効化後、Production `/operations`からJob作成可能なことを確認

### `start_backend` Production Acceptance

2026-09-02 18:50 JSTに、既に`running + healthy`な`mc-main`へ`start_backend`を1回実行した。

- Browser `POST /api/operations/jobs`: HTTP 201
- Job ID: `a941cf40-2b78-4c7c-b18a-9e57a47b271a`
- actor: Discord / owner
- transition: `queued -> leased -> running -> succeeded`
- terminal phase: `health_gate_passed`
- Agent lease owner: `oci-minecraft-01:operation-worker`
- error code: none
- post-operation `mc-main`: `running / healthy`, restart count `0`, OOM `false`, exit code `0`
- post-operation Minecraft Public Ping / Backend Ping: both reachable

This proves the Production path `Browser -> Queue -> Agent -> fixed lifecycle helper -> Health Gate -> Operation UI` for the idempotent Start case.

## Remaining disruptive acceptance gate

`restart_backend` and `stop_backend` are implemented and covered by CI / helper tests / DB contract, but **Production disruptive acceptance is intentionally not complete yet**.

The latest `minecraft-main` full S3 backup is successful and remote-synced, but current structured telemetry does not prove Restore Ready:

- `sha256_verified`: unknown / null
- `restore_tested_at`: unknown / null
- `retention_expires_at`: unknown / null

`docs/backup-center.md` defines Restore Ready as requiring a current successful backup, `sha256Verified=true`, valid Retention evidence and a Restore Test inside policy. Missing values must not be treated as success.

Before any Production restart/stop acceptance, require all of the following:

1. Identify the actual Production backup producer and restore procedure on OCI from current systemd/scripts/config; do not invent a restore command from the Dashboard repository.
2. Verify the latest backup artifact checksum without modifying Production world data.
3. Perform or verify an isolated, non-destructive restore test and report `restore_tested_at` through the existing Backup Reporter contract.
4. Ensure Retention evidence is available and not expired.
5. Confirm active Operation Job count is zero.
6. Confirm `mc-main` is `running / healthy`, restart count stable, OOM=false and Public/Backend Ping are reachable immediately before the maintenance test.
7. Use an explicit maintenance window and have both Browser/OCI gate rollback steps ready.
8. Run `restart_backend` with exact `RESTART`, then verify Job/audit/logs/Docker/Pings.
9. Run `stop_backend` with exact `STOP` only as the final disruptive test, then restore service with `start_backend` in the same maintenance window and verify the full path again.
10. Do not close Issue #68 after Phase B-1; the parent issue still contains startup log streaming, terminal-like operation improvements, Mode Switching and Minecraft Command Console work.

## Operational observation

On the 2026-09-03 handoff check, the claim endpoint had a small number of intermittent generic runtime error records during the previous 24 hours, while the current poll stream was continuously returning HTTP 200 and no active Operation Job was stuck. Treat this as an observability item for the next phase: if it recurs, classify the failure without logging Secret/request bodies and confirm whether it is a transient Supabase/network failure before changing retry semantics.
