import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import bundle from "../../../contracts/ivrm/operational-telemetry.v1.bundle.json" with { type: "json" };

export const TELEMETRY_LIMITS = bundle.ingest.limits;
export type TelemetryCode = "invalid_payload" | "authentication_failed" | "source_not_allowed" |
  "content_conflict" | "payload_too_large" | "unsupported_media_type" | "rate_limited" |
  "storage_unavailable" | "service_not_configured" | "not_enabled";
export class TelemetryError extends Error {
  constructor(public readonly status: number, public readonly code: TelemetryCode) { super(code); }
}
export type TelemetrySource = {
  serviceId: string; sourceId: string; type: string; provider: string;
  resourceId?: string; hostId?: string;
};
export type TelemetryEvent = {
  eventId: string; observedAt: string; source: TelemetrySource; kind: string;
  level: string; outcome: string; message: string;
  actor?: { type: string; provider: string; subjectId?: string; displayName?: string; role?: string };
  clientIp?: { address: string; provenance: "direct_peer" | "verified_edge" };
  requestId?: string; traceId?: string; action?: string; targetId?: string; ruleId?: string; confidence?: string;
};
export type TelemetryBatch = { schemaVersion: 1; batchId: string; producerId: string; events: TelemetryEvent[] };
export type TelemetryReceipt = { accepted: true; batchId: string; replayed: boolean; acceptedEvents: number; duplicateEvents: number };

// Only trusted, revision-pinned schemas are compiled. x-ivrm annotations describe
// runtime checks below and in the database; Ajv does not enforce those annotations.
const ajv = new Ajv2020({ strictSchema: false, coerceTypes: false, removeAdditional: false, useDefaults: false });
addFormats(ajv, { mode: "full" });
const validateBatch = ajv.compile<TelemetryBatch>(bundle.ingest.batchSchema);
const validateReceipt = ajv.compile<TelemetryReceipt>(bundle.ingest.responseSchema);
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export function canonicalEventDigest(event: TelemetryEvent): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(obj).sort().map(key => [key, canonical(obj[key])]));
    }
    return value;
  };
  return sha(JSON.stringify(canonical(event)));
}

export function parseTelemetryBatch(raw: Uint8Array, now = Date.now()): TelemetryBatch {
  if (raw.byteLength > TELEMETRY_LIMITS.maxBytes) throw new TelemetryError(413, "payload_too_large");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
  catch { throw new TelemetryError(400, "invalid_payload"); }
  if (!validateBatch(value)) throw new TelemetryError(400, "invalid_payload");
  const ids = new Set<string>();
  for (const event of value.events) {
    const id = event.eventId.toLowerCase();
    const age = now - Date.parse(event.observedAt);
    if (ids.has(id) || !Number.isFinite(age) || age < -TELEMETRY_LIMITS.maxEventFutureSeconds * 1000 ||
      age > TELEMETRY_LIMITS.maxEventAgeSeconds * 1000) throw new TelemetryError(400, "invalid_payload");
    ids.add(id);
  }
  return value;
}

export function parseTelemetrySecrets(raw: string | undefined): Record<string, string> {
  try {
    const value: unknown = JSON.parse(raw ?? "");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const result: Record<string, string> = Object.create(null);
    for (const [id, secret] of Object.entries(value)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret)) throw new Error();
      result[id] = secret;
    }
    if (Object.keys(result).length === 0) throw new Error();
    return result;
  } catch { throw new TelemetryError(503, "service_not_configured"); }
}

export function authenticateTelemetry(headers: Headers, raw: Uint8Array, secrets: Record<string, string>, now = Date.now()) {
  const producerId = headers.get("X-IVRM-Producer-ID") ?? "";
  const timestamp = headers.get("X-IVRM-Timestamp") ?? "";
  const nonce = headers.get("X-IVRM-Nonce") ?? "";
  const signature = headers.get("X-IVRM-Signature") ?? "";
  const secret = Object.hasOwn(secrets, producerId) ? secrets[producerId] : null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(producerId) || !secret || !/^[0-9]{1,12}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > bundle.ingest.authentication.maxSkewSeconds ||
    !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) throw new TelemetryError(401, "authentication_failed");
  const expected = createHmac("sha256", secret).update(`POST\n${bundle.ingest.path}\n${producerId}\n${timestamp}\n${nonce}\n`).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new TelemetryError(401, "authentication_failed");
  return { producerId, nonce, bodySha256: sha(raw) };
}

export async function readTelemetryBody(request: Request): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type") ?? "";
  const encoding = request.headers.get("content-encoding") ?? "identity";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(contentType) || encoding.toLowerCase() !== "identity") throw new TelemetryError(415, "unsupported_media_type");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > TELEMETRY_LIMITS.maxBytes)) throw new TelemetryError(413, "payload_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new TelemetryError(400, "invalid_payload");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > TELEMETRY_LIMITS.maxBytes) { await reader.cancel().catch(() => undefined); throw new TelemetryError(413, "payload_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
  return raw;
}

export function verifyTelemetryReceipt(value: unknown, batch: TelemetryBatch): TelemetryReceipt {
  if (!validateReceipt(value) || value.batchId.toLowerCase() !== batch.batchId.toLowerCase() ||
    value.acceptedEvents + value.duplicateEvents !== batch.events.length) throw new TelemetryError(503, "storage_unavailable");
  return value;
}
