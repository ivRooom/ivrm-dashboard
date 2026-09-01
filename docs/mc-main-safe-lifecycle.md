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
