import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readFilesystemCapacity } from "./filesystem-health";

/** Existing spool only: no creation, migration, claim, retry, deletion or network. */
export function readSpoolHealth(directory: string, producer: string, now = Date.now(), expectedSources?: readonly string[]) {
  if (!isAbsolute(directory) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(producer) || !Number.isSafeInteger(now) || now < 0) throw new Error("invalid_configuration");
  if (expectedSources !== undefined && (!Array.isArray(expectedSources) || expectedSources.length < 1 || expectedSources.length > 64 ||
      expectedSources.some(source => typeof source !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(source)) ||
      new Set(expectedSources).size !== expectedSources.length)) throw new Error("invalid_configuration");
  const dir = lstatSync(directory), file = join(directory, "telemetry.sqlite");
  const stat = lstatSync(file);
  if (!dir.isDirectory() || dir.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      (process.platform !== "win32" && ((dir.mode & 0o077) || (stat.mode & 0o077)))) throw new Error("unsafe_spool");
  // Failure is unknown/error, never substitute ample space. No disk writes or allocation probes.
  const filesystem = readFilesystemCapacity(directory);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=2000; BEGIN");
    const metadata = db.prepare("SELECT producer,configuration FROM metadata").all();
    if (metadata.length !== 1 || metadata[0].producer !== producer) throw new Error("producer_mismatch");
    const config: unknown = JSON.parse(String(metadata[0].configuration));
    if (!Array.isArray(config) || config.length !== 3 || config.some(value => !Number.isSafeInteger(value)) ||
        config[0] < 1 || config[0] > 10000 || config[1] < 65536 || config[1] > 67108864 || config[2] < 1 || config[2] > 100) throw new Error("invalid_configuration");
    const row = db.prepare(`SELECT count(*) AS total,
      coalesce(sum(state='pending'),0) AS pending, coalesce(sum(state='blocked'),0) AS blocked,
      coalesce(sum(state='delivered'),0) AS delivered, coalesce(sum(length(raw)),0) AS bytes,
      min(CASE WHEN state IN ('pending','blocked') THEN oldest END) AS oldest,
      coalesce(sum(state NOT IN ('pending','blocked','delivered')),0) AS invalid FROM jobs`).get()!;
    const total = Number(row.total), pending = Number(row.pending), blocked = Number(row.blocked), delivered = Number(row.delivered), bytes = Number(row.bytes);
    const oldest = row.oldest === null ? null : Number(row.oldest);
    if (Number(row.invalid) || [total,pending,blocked,delivered,bytes].some(value => !Number.isSafeInteger(value) || value < 0) ||
        ((pending + blocked > 0) && (oldest === null || !Number.isFinite(oldest) || oldest < 0 || oldest > now + 60_000))) throw new Error("invalid_spool_status");
    const oldestUnsentEventAgeMs = oldest === null ? null : Math.max(0, now - oldest);
    const reasons: string[] = [];
    reasons.push(...filesystem.reasons);
    if (blocked) reasons.push("blocked_batches");
    if (oldestUnsentEventAgeMs !== null && oldestUnsentEventAgeMs >= 300_000) reasons.push("old_unsent_events");
    if (total >= config[0] * 0.8) reasons.push("batch_capacity");
    if (bytes >= config[1] * 0.8) reasons.push("payload_capacity");
    let captureFreshness = "unknown";
    let captureChecks: { expected: number; recent: number; stale: number; failed: number; missing: number } | null = null;
    if (expectedSources) {
      captureChecks = { expected: expectedSources.length, recent: 0, stale: 0, failed: 0, missing: 0 };
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='capture_checks'").get();
      const lookup = exists ? db.prepare("SELECT checked_at,result FROM capture_checks WHERE source=?") : null;
      for (const source of expectedSources) {
        const check = lookup?.get(source);
        if (!check) { captureChecks.missing++; continue; }
        const at = Number(check.checked_at);
        if (!Number.isSafeInteger(at) || at < 0 || at > now + 60_000 || !["checked","failed"].includes(String(check.result))) throw new Error("invalid_capture_status");
        if (check.result === "failed") captureChecks.failed++;
        else if (now - at >= 120_000) captureChecks.stale++;
        else captureChecks.recent++;
      }
      if (captureChecks.missing) reasons.push("capture_missing");
      if (captureChecks.failed) reasons.push("capture_failed");
      if (captureChecks.stale) reasons.push("capture_stale");
      captureFreshness = captureChecks.recent === captureChecks.expected ? "recent_checks" : "attention";
    }
    db.exec("COMMIT");
    return { schemaVersion: 1, checkedAt: new Date(now).toISOString(), status: reasons.length ? "attention" : "queue_clear",
      reasons, batches: { total, pending, blocked, delivered, limit: config[0] as number },
      payloadBytes: { used: bytes, limit: config[1] as number }, oldestUnsentEventAgeMs,
      captureFreshness, captureChecks, upstreamHealth: "unknown", filesystemFreeSpace: "measured",
      filesystem: { totalBytes: filesystem.totalBytes, availableBytes: filesystem.availableBytes, inodeAvailability: filesystem.inodeAvailability } };
  } finally { db.close(); }
}
