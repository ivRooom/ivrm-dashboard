import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTarget, isBackupAgePaused, getBackupCenterSnapshot } from "../apps/web/lib/backups.ts";

const now = Date.parse("2026-10-17T09:00:00Z");
const atAge = seconds => new Date(now - seconds * 1000).toISOString();
function target() {
  const success = {
    runId: "00000000-0000-4000-8000-000000000001",
    completedAt: atAge(600), sizeBytes: 100, sha256Verified: true,
    destinationType: "s3", remoteSyncedAt: atAge(30),
    restoreTestedAt: atAge(300), retentionExpiresAt: atAge(-86400),
  };
  return {
    policyId: 1, hostId: "host", serverId: "server", hostDisplayName: "Host",
    backupTarget: "test", gameMode: "test", backupType: "full",
    remoteSyncRequired: true, warningAfterSeconds: 3600, criticalAfterSeconds: 7200,
    remoteSyncWarningSeconds: 120, restoreTestWarningSeconds: 86400,
    latestSuccess: success,
    latest: { ...success, outcome: "success", startedAt: atAge(900),
      durationSeconds: 300, failureCode: null },
  };
}

test("fresh verified evidence is healthy and restore ready", () => {
  const result = evaluateTarget(target(), now);
  assert.equal(result.health, "healthy");
  assert.equal(result.restoreReadiness, "ready");
  assert.equal(result.backupAgeSeconds, 600);
});

test("critical age does not hide missing checksum, sync, retention or restore evidence", () => {
  const input = target();
  Object.assign(input.latestSuccess, { completedAt: atAge(7201), sha256Verified: null,
    remoteSyncedAt: null, retentionExpiresAt: null, restoreTestedAt: null });
  const result = evaluateTarget(input, now);
  assert.equal(result.health, "critical");
  assert.equal(result.restoreReadiness, "unknown");
  assert.equal(result.remoteSyncPending, true);
  for (const reason of ["Critical SLA", "SHA-256", "Remote Sync", "Retention", "Restore Test"])
    assert.ok(result.healthReasons.some(value => value.includes(reason)), reason);
});

test("restore test expiry is independent of the backup freshness policy", () => {
  const input = target();
  input.warningAfterSeconds = 172800;
  input.criticalAfterSeconds = 259200;
  input.latestSuccess.completedAt = atAge(90000);
  input.latestSuccess.restoreTestedAt = atAge(86401);
  const result = evaluateTarget(input, now);
  assert.equal(result.health, "warning");
  assert.equal(result.restoreReadiness, "warning");
  assert.ok(result.healthReasons.some(value => value.includes("Policy期間")));
});

test("policy-scoped restore evidence can precede the newest backup", () => {
  const input = target();
  input.latestSuccess.restoreTestedAt = atAge(3600);
  const result = evaluateTarget(input, now);
  assert.equal(result.health, "healthy");
  assert.equal(result.restoreReadiness, "ready");
});

test("future restore timestamps cannot prove readiness", () => {
  const input = target();
  input.latestSuccess.restoreTestedAt = atAge(-1);
  const result = evaluateTarget(input, now);
  assert.equal(result.health, "warning");
  assert.equal(result.restoreReadiness, "unknown");
  assert.ok(result.healthReasons.some(value => value.includes("未来")));
});

test("missing evidence is not a checksum failure or healthy backup", () => {
  for (const field of ["sha256Verified", "retentionExpiresAt", "restoreTestedAt"]) {
    const input = target();
    input.latestSuccess[field] = null;
    const result = evaluateTarget(input, now);
    assert.equal(result.health, "warning", field);
    assert.equal(result.restoreReadiness, "unknown", field);
    assert.ok(!result.healthReasons.some(value => value.includes("検証失敗")));
  }
});

test("latest failure and checksum failure retain critical severity alongside warnings", () => {
  for (const fail of [input => { input.latest.outcome = "failed"; },
    input => { input.latestSuccess.sha256Verified = false; }]) {
    const input = target(); fail(input);
    input.latestSuccess.restoreTestedAt = atAge(86401);
    input.latestSuccess.retentionExpiresAt = null;
    assert.equal(evaluateTarget(input, now).health, "critical");
  }
});

test("age and restore SLA boundaries are inclusive; retention expiry is exclusive", () => {
  const input = target();
  input.latestSuccess.completedAt = atAge(3600);
  input.restoreTestWarningSeconds = 3600;
  input.latestSuccess.restoreTestedAt = atAge(3600);
  assert.equal(evaluateTarget(input, now).health, "healthy");
  input.latestSuccess.completedAt = atAge(7200);
  assert.equal(evaluateTarget(input, now).health, "warning");
  input.latestSuccess.retentionExpiresAt = atAge(0);
  assert.equal(evaluateTarget(input, now).health, "critical");
  assert.notEqual(evaluateTarget(input, now).restoreReadiness, "ready");
});

test("no successful backup remains unknown and cannot be ready", () => {
  const input = target(); input.latestSuccess = null; input.latest = null;
  const result = evaluateTarget(input, now);
  assert.equal(result.health, "unknown");
  assert.equal(result.restoreReadiness, "unknown");
  assert.equal(result.backupAgeSeconds, null);
});

test("bounded pause skips age only and retains actual artifact age", () => {
  const input = target();
  input.latestSuccess.completedAt = atAge(7201);
  input.agePausedUntil = atAge(-60);
  input.agePauseReason = "Issue #138: final archive review";
  const result = evaluateTarget(input, now);
  assert.equal(result.health, "healthy");
  assert.equal(result.backupAgeSeconds, 7201);
  assert.ok(result.healthReasons.some(value => value.includes("一時停止")));
  input.agePausedUntil = atAge(0);
  assert.equal(evaluateTarget(input, now).health, "critical");
});

test("pause cannot hide integrity, retention, sync, restore or run failures", () => {
  for (const [change, severity] of [
    [input => { input.latestSuccess.sha256Verified = false; }, "critical"],
    [input => { input.latestSuccess.retentionExpiresAt = atAge(0); }, "critical"],
    [input => { input.latest.outcome = "failed"; }, "critical"],
    [input => { input.latestSuccess.remoteSyncedAt = null; }, "warning"],
    [input => { input.latestSuccess.restoreTestedAt = atAge(86401); }, "warning"],
    [input => { input.latestSuccess.sha256Verified = null; }, "warning"],
  ]) {
    const input = target(); change(input);
    input.agePausedUntil = atAge(-60); input.agePauseReason = "review";
    assert.equal(evaluateTarget(input, now).health, severity);
  }
  const input = target();
  input.agePausedUntil = atAge(-60); input.agePauseReason = "review";
  input.latestSuccess = null; input.latest = null;
  assert.equal(evaluateTarget(input, now).health, "unknown");
});

test("missing, invalid or expired pause never suppresses age", () => {
  for (const [until, reason] of [[null, null], ["bad", "review"], [atAge(-60), " "], [atAge(1), "review"]]) {
    assert.equal(isBackupAgePaused({ agePausedUntil: until, agePauseReason: reason }, now), false);
  }
});

test("v2 RPC errors or malformed pause metadata fail visibly", async () => {
  const originalFetch = globalThis.fetch;
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://example.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
  try {
    globalThis.fetch = async url => String(url).endsWith("get_backup_center_v2")
      ? new Response("{}", { status: 404 }) : Response.json([]);
    await assert.rejects(getBackupCenterSnapshot("24h"), /404/);
    globalThis.fetch = async url => Response.json(String(url).endsWith("get_backup_center_v2")
      ? [{ policy_id: 1, age_paused_until: "bad", age_pause_reason: "review" }] : []);
    await assert.rejects(getBackupCenterSnapshot("24h"), /形式が不正/);
    const row = { policy_id: 1, host_id: "00000000-0000-4000-8000-000000000001",
      server_id: "test", host_display_name: "Test", backup_target: "test", game_mode: "test",
      backup_type: "full", remote_sync_required: true, warning_after_seconds: 3600,
      critical_after_seconds: 7200, remote_sync_warning_seconds: 120, restore_test_warning_seconds: 86400,
      latest_run_id: null, latest_success_run_id: null,
      age_paused_until: new Date(Date.now()+60000).toISOString(), age_pause_reason: "review" };
    globalThis.fetch = async url => Response.json(String(url).endsWith("get_backup_center_v2") ? [row] : []);
    assert.equal((await getBackupCenterSnapshot("24h")).targets[0].agePauseReason, "review");
    row.age_pause_reason = "🛠️".repeat(80);
    assert.equal((await getBackupCenterSnapshot("24h")).targets[0].agePauseReason, row.age_pause_reason);
    for (const reason of [" ", "\t", "\u00a0", "\u3000", " ".repeat(256)+"review"]) {
      row.age_pause_reason = reason;
      await assert.rejects(getBackupCenterSnapshot("24h"), /形式が不正/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (oldUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
  }
});
