import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTarget } from "../apps/web/lib/backups.ts";

const now = Date.parse("2026-10-17T09:00:00Z");
const atAge = seconds => new Date(now - seconds * 1000).toISOString();
function target() {
  const success = {
    runId: "00000000-0000-4000-8000-000000000001",
    completedAt: atAge(60), sizeBytes: 100, sha256Verified: true,
    destinationType: "s3", remoteSyncedAt: atAge(30),
    restoreTestedAt: atAge(300), retentionExpiresAt: atAge(-86400),
  };
  return {
    policyId: 1, hostId: "host", serverId: "server", hostDisplayName: "Host",
    backupTarget: "test", gameMode: "test", backupType: "full",
    remoteSyncRequired: true, warningAfterSeconds: 3600, criticalAfterSeconds: 7200,
    remoteSyncWarningSeconds: 120, restoreTestWarningSeconds: 86400,
    latestSuccess: success,
    latest: { ...success, outcome: "success", startedAt: atAge(90),
      durationSeconds: 30, failureCode: null },
  };
}

test("fresh verified evidence is healthy and restore ready", () => {
  const result = evaluateTarget(target(), now);
  assert.equal(result.health, "healthy");
  assert.equal(result.restoreReadiness, "ready");
  assert.equal(result.backupAgeSeconds, 60);
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

test("old restore test is warning even when the latest backup is recent", () => {
  const input = target();
  input.latestSuccess.restoreTestedAt = atAge(86401);
  const result = evaluateTarget(input, now);
  assert.equal(result.health, "warning");
  assert.equal(result.restoreReadiness, "warning");
  assert.ok(result.healthReasons.some(value => value.includes("Policy期間")));
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
  input.latestSuccess.restoreTestedAt = atAge(86400);
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
