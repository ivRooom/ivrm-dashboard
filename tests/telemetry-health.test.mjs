import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TelemetrySpool } from "../apps/telemetry-sender/spool.ts";
import { readSpoolHealth } from "../apps/telemetry-sender/health.ts";

const producer = "fixture-producer", secret = "a".repeat(64);
const now = Date.now();
function batch(time = now, message = "private-payload-must-not-export") {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, producerId: producer, batchId: randomUUID(), events: [{ eventId: randomUUID(), observedAt: new Date(time).toISOString(), source: { sourceId: "fixture-log", serviceId: "fixture", type: "container", provider: "oci" }, kind: "log", level: "info", outcome: "observed", message }] }));
}
function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ivrm-health-"));
  const spool = new TelemetrySpool(directory, producer, { now: () => now, ...options });
  return { directory, spool, cleanup() { spool.close(); rmSync(directory, { recursive: true }); } };
}
test("missing spool is unknown/error and never creates a healthy empty queue", () => {
  const directory = mkdtempSync(join(tmpdir(), "ivrm-health-missing-"));
  try {
    assert.throws(() => readSpoolHealth(directory, producer, now));
    assert.equal(existsSync(join(directory, "telemetry.sqlite")), false);
  } finally { rmSync(directory, { recursive: true }); }
});
test("read-only snapshot reports counts and age without payloads or mutation", () => {
  const f = fixture();
  try {
    f.spool.enqueue(batch());
    const before = readFileSync(join(f.directory, "telemetry.sqlite"));
    const report = readSpoolHealth(f.directory, producer, now + 300_000);
    assert.equal(report.batches.pending, 1);
    assert.equal(report.oldestUnsentEventAgeMs, 300_000);
    assert.deepEqual(report.reasons, ["old_unsent_events"]);
    assert.equal(report.captureFreshness, "unknown");
    assert.doesNotMatch(JSON.stringify(report), /private-payload|fixture-log|fixture-producer/);
    assert.deepEqual(readFileSync(join(f.directory, "telemetry.sqlite")), before);
    assert.throws(() => readSpoolHealth(f.directory, "other-producer", now), /producer_mismatch/);
  } finally { f.cleanup(); }
});
test("blocked evidence is attention even before event-age threshold", async () => {
  const f = fixture();
  try {
    f.spool.enqueue(batch());
    await f.spool.deliver(secret, async () => new Response(null, { status: 403 }));
    const report = readSpoolHealth(f.directory, producer, now);
    assert.equal(report.status, "attention");
    assert.equal(report.batches.blocked, 1);
    assert.deepEqual(report.reasons, ["blocked_batches"]);
    assert.ok(report.payloadBytes.used > 0);
  } finally { f.cleanup(); }
});
test("delivered receipts still consume row capacity, but not pending age or bytes", async () => {
  const f = fixture({ maxRows: 1 });
  try {
    f.spool.enqueue(batch());
    await f.spool.deliver(secret, async request => {
      const body = await request.json();
      return Response.json({ accepted: true, batchId: body.batchId, replayed: false, acceptedEvents: 1, duplicateEvents: 0 }, { status: 202 });
    });
    const report = readSpoolHealth(f.directory, producer, now + 900_000);
    assert.deepEqual(report.reasons, ["batch_capacity"]);
    assert.equal(report.batches.delivered, 1);
    assert.equal(report.payloadBytes.used, 0);
    assert.equal(report.oldestUnsentEventAgeMs, null);
  } finally { f.cleanup(); }
});
test("empty initialized spool does not assert source or filesystem health", () => {
  const f = fixture();
  try {
    const report = readSpoolHealth(f.directory, producer, now);
    assert.equal(report.status, "queue_clear");
    assert.equal(report.captureFreshness, "unknown");
    assert.equal(report.filesystemFreeSpace, "not-measured");
    assert.throws(() => readSpoolHealth(f.directory, producer, NaN), /invalid_configuration/);
  } finally { f.cleanup(); }
});
test("payload capacity warns before enqueue limit and CLI returns attention code", () => {
  const f = fixture({ maxBytes: 65536 });
  try {
    let report;
    do {
      f.spool.enqueue(batch(now, "x".repeat(2000)));
      report = readSpoolHealth(f.directory, producer, now);
    } while (!report.reasons.includes("payload_capacity"));
    assert.ok(report.payloadBytes.used < report.payloadBytes.limit);
    const root = fileURLToPath(new URL("../", import.meta.url));
    const cli = fileURLToPath(new URL("../apps/telemetry-sender/cli.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../apps/web/node_modules/tsx/dist/cli.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [tsx, cli, "health", f.directory, producer], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).status, "attention");
    assert.doesNotMatch(result.stdout, /private-payload|fixture-producer/);
    const missing = spawnSync(process.execPath, [tsx, cli, "health", join(f.directory, "missing"), producer], { cwd: root, encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /telemetry_sender_failed/);
    assert.doesNotMatch(missing.stderr, /ENOENT|telemetry.sqlite/);
    assert.equal(existsSync(join(f.directory, "missing")), false);
  } finally { f.cleanup(); }
});
