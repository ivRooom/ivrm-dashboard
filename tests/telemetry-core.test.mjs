import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { authenticateTelemetry, canonicalEventDigest, parseTelemetryBatch, parseTelemetrySecrets, readTelemetryBody } from "../apps/web/lib/telemetry-core.ts";
import { handleTelemetryRequest } from "../apps/web/lib/telemetry-ingest.ts";
import { POST } from "../apps/web/app/api/agent/telemetry/route.ts";

const now = Date.parse("2026-10-17T09:00:00Z");
const secret = "a".repeat(64);
const fixtureDir = new URL("../contracts/ivrm/operational-telemetry-fixtures/", import.meta.url);
const sample = JSON.parse(await readFile(new URL("valid/container.json", fixtureDir), "utf8"));
const encode = value => new TextEncoder().encode(JSON.stringify(value));
const body = () => structuredClone(sample);
function signed(raw, overrides = {}) {
  const id = overrides.producerId ?? sample.producerId;
  const timestamp = overrides.timestamp ?? String(now / 1000);
  const nonce = "1".repeat(32);
  const signature = createHmac("sha256", secret).update(`POST\n/api/agent/telemetry\n${id}\n${timestamp}\n${nonce}\n`).update(raw).digest("hex");
  return new Headers({ "Content-Type": "application/json", "X-IVRM-Producer-ID": id, "X-IVRM-Timestamp": timestamp,
    "X-IVRM-Nonce": nonce, "X-IVRM-Signature": signature });
}
const deps = persist => ({ enabled: true, now: () => now, secrets: () => ({ [sample.producerId]: secret }), persist });
const request = (raw, headers = signed(raw)) => new Request("https://fixture.invalid/api/agent/telemetry", { method: "POST", headers, body: raw });
const receipt = { accepted: true, batchId: sample.batchId, replayed: false, acceptedEvents: 1, duplicateEvents: 0 };

test("candidate contract is byte-pinned and cannot be enabled in the public route", async () => {
  const file = new URL("../contracts/ivrm/operational-telemetry.v1.bundle.json", import.meta.url);
  const pin = JSON.parse(await readFile(new URL("../contracts/ivrm/operational-telemetry.v1.pin.json", import.meta.url), "utf8"));
  assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), pin.sha256);
  const previous = process.env.IVRM_TELEMETRY_INGEST_ENABLED;
  process.env.IVRM_TELEMETRY_INGEST_ENABLED = "true";
  try { assert.equal((await POST(request(encode(sample)))).status, 404); }
  finally { if (previous === undefined) delete process.env.IVRM_TELEMETRY_INGEST_ENABLED; else process.env.IVRM_TELEMETRY_INGEST_ENABLED=previous; }
});

test("real draft-2020 validator matches every pinned valid/invalid fixture", async () => {
  for (const group of ["valid", "invalid"]) {
    for (const name of await readdir(new URL(`${group}/`, fixtureDir))) {
      const raw = await readFile(new URL(`${group}/${name}`, fixtureDir));
      if (group === "valid") assert.doesNotThrow(() => parseTelemetryBatch(raw, now), name);
      else assert.throws(() => parseTelemetryBatch(raw, now), name);
    }
  }
});

test("signature binds endpoint, producer, attempt timestamp and raw bytes", () => {
  const raw = encode(sample), headers = signed(raw);
  assert.equal(authenticateTelemetry(headers, raw, { [sample.producerId]: secret }, now).producerId, sample.producerId);
  for (const [name, value] of [["X-IVRM-Producer-ID", "other"], ["X-IVRM-Timestamp", String(now/1000-301)],
    ["X-IVRM-Nonce", "0".repeat(32)], ["X-IVRM-Signature", "0".repeat(64)]]) {
    const changed = new Headers(headers); changed.set(name, value);
    assert.throws(() => authenticateTelemetry(changed, raw, { [sample.producerId]: secret }, now));
  }
  assert.throws(() => authenticateTelemetry(headers, new TextEncoder().encode(JSON.stringify(sample, null, 2)), { [sample.producerId]: secret }, now));
  const legacy = new Headers(headers);
  legacy.set("X-IVRM-Signature", createHmac("sha256", secret).update(`${now/1000}.${"1".repeat(32)}.`).update(raw).digest("hex"));
  assert.throws(() => authenticateTelemetry(legacy, raw, { [sample.producerId]: secret }, now));
});

test("wrong producer subject is refused before any persistence", async () => {
  const value = body(); value.producerId = "other";
  const raw = encode(value); let calls = 0;
  const response = await handleTelemetryRequest(request(raw), deps(async () => { calls++; }));
  assert.equal(response.status, 401); assert.equal(calls, 0);
});

test("alternate request paths and methods cannot reuse an endpoint signature", async () => {
  let calls = 0; const dependencies = deps(async () => { calls++; });
  for (const url of ["https://fixture.invalid/api/agent/logs", "https://fixture.invalid/api/agent/telemetry?source=other"]) {
    const raw = encode(sample);
    assert.equal((await handleTelemetryRequest(new Request(url,{method:"POST",headers:signed(raw),body:raw}),dependencies)).status,400);
  }
  assert.equal((await handleTelemetryRequest(new Request("https://fixture.invalid/api/agent/telemetry"),dependencies)).status,400);
  assert.equal(calls,0);
});

test("byte limits, encodings and case-insensitive duplicate UUIDs fail closed", async () => {
  assert.throws(() => parseTelemetryBatch(new Uint8Array(65537), now));
  assert.throws(() => parseTelemetryBatch(new Uint8Array([0xff]), now));
  const value = body(); value.events[0].eventId = "aaaaaaaa-0000-4000-8000-000000000001";
  value.events.push({ ...value.events[0], eventId: value.events[0].eventId.toUpperCase() });
  assert.throws(() => parseTelemetryBatch(encode(value), now));
  const raw = encode(sample); const headers = signed(raw); headers.set("Content-Encoding", "gzip");
  await assert.rejects(readTelemetryBody(request(raw, headers)));
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } });
  const streamed = new Request("https://fixture.invalid/api/agent/telemetry", { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" });
  await assert.rejects(readTelemetryBody(streamed)); assert.equal(cancelled, true);
});

test("event comparison is canonical but preserves array and Unicode values", () => {
  const event = sample.events[0];
  assert.equal(canonicalEventDigest(event), canonicalEventDigest(Object.fromEntries(Object.entries(event).reverse())));
  assert.notEqual(canonicalEventDigest({ ...event, message: "é" }), canonicalEventDigest({ ...event, message: "e\u0301" }));
});

test("disabled, unsigned and invalid config requests have no store side effects", async () => {
  let calls = 0; const dependencies = deps(async () => { calls++; });
  const raw = encode(sample);
  assert.equal((await handleTelemetryRequest(request(raw), { ...dependencies, enabled: false })).status, 404);
  const unsigned = new Headers({ "Content-Type": "application/json" });
  assert.equal((await handleTelemetryRequest(request(raw, unsigned), dependencies)).status, 401);
  assert.equal((await handleTelemetryRequest(request(raw), { ...dependencies, secrets: () => parseTelemetrySecrets(undefined) })).status, 503);
  assert.equal(calls, 0);
  for (const rawMap of ["{}", '{"constructor":"short"}', "[]", "null"]) assert.throws(() => parseTelemetrySecrets(rawMap));
});

test("only redacted copies reach persistence, while original content defines deduplication", async () => {
  const value = body(); value.events[0].message = "password=supersecret 192.0.2.10";
  const raw = encode(value); let stored;
  const response = await handleTelemetryRequest(request(raw), deps(async input => { stored = input; return { status: 202, receipt }; }));
  assert.equal(response.status, 202);
  assert.ok(!JSON.stringify(stored).includes("supersecret")); assert.ok(!JSON.stringify(stored).includes("192.0.2.10"));
  assert.equal(stored.events[0].digest, canonicalEventDigest(value.events[0]));
  assert.equal(value.events[0].message, "password=supersecret 192.0.2.10");
});

test("storage errors and malformed ACKs never become success or raw diagnostics", async () => {
  for (const persist of [async () => { throw new Error("private DB URL and credential"); }, async () => ({ status: 202, receipt: { ...receipt, acceptedEvents: 0 } }),
    async () => ({ status: 202, receipt: { ...receipt, replayed: true } }), async () => ({ status: 409, code: "raw secret" })]) {
    const response = await handleTelemetryRequest(request(encode(sample)), deps(persist));
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { accepted: false, code: "storage_unavailable" });
  }
  const limited = await handleTelemetryRequest(request(encode(sample)), deps(async () => ({ status: 429, code: "rate_limited" })));
  assert.equal(limited.status, 429); assert.equal(limited.headers.get("Retry-After"), "60");
});
