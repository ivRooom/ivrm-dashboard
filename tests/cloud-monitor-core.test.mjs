import assert from "node:assert/strict";
import test from "node:test";
import { parseCloudEnvelope, cloudHealth } from "../apps/web/lib/cloud-monitor-core.ts";
const now = Date.parse("2026-10-14T05:00:00Z");
const envelope = () => ({ kind: "cloud-monitor-v1", serverId: "oci-minecraft-01", observedAt: new Date(now).toISOString(), results: [{ id: "aws-app", status: "operational", reasonCode: "ok" }] });
const parse = value => parseCloudEnvelope(new TextEncoder().encode(JSON.stringify(value)), now);
test("accepts a bounded observation without arbitrary provider text", () => {
  assert.equal(parse(envelope()).results[0].id, "aws-app");
});
test("rejects cross-protocol payloads, duplicate targets, extra data and false health", () => {
  for (const mutate of [
    x => x.kind = "heartbeat", x => x.results.push(x.results[0]),
    x => x.results[0].raw = "secret", x => x.results[0].reasonCode = "provider response",
    x => x.results[0].reasonCode = "auth_error", x => x.results = [],
    x => x.serverId = "../invalid", x => x.results[0].id = "../invalid",
  ]) {
    const value = envelope(); mutate(value); assert.throws(() => parse(value));
  }
});
test("rejects missing timezone, stale and future observations", () => {
  for (const time of ["2026-10-14T05:00:00", "invalid", new Date(now-300001).toISOString(), new Date(now+30001).toISOString()]) {
    const value = envelope(); value.observedAt = time; assert.throws(() => parse(value));
  }
});
test("never calls missing or stale collection healthy", () => {
  assert.equal(cloudHealth("operational", null, 900, now), "unknown");
  assert.equal(cloudHealth("operational", new Date(now-901000).toISOString(), 900, now), "stale");
  assert.equal(cloudHealth("operational", new Date(now+60000).toISOString(), 900, now), "unknown");
  assert.equal(cloudHealth("error", new Date(now).toISOString(), 900, now), "error");
});
