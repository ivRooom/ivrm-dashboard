import { canonicalEventDigest, authenticateTelemetry, parseTelemetryBatch, readTelemetryBody,
  TelemetryError, verifyTelemetryReceipt, type TelemetryBatch, type TelemetryCode, type TelemetryReceipt } from "./telemetry-core";
import { redactConsoleLogMessage } from "./log-report";

export type TelemetryPersistence = {
  producerId: string; batchId: string; nonce: string; bodySha256: string;
  events: { digest: string; event: TelemetryBatch["events"][number] }[];
};
export type TelemetryDependencies = {
  enabled: boolean;
  secrets: () => Record<string, string>;
  persist: (input: TelemetryPersistence) => Promise<unknown>;
  now?: () => number;
};
const errorCodes: Readonly<Record<number, readonly TelemetryCode[]>> = {
  400: ["invalid_payload"], 401: ["authentication_failed"], 403: ["source_not_allowed"],
  404: ["not_enabled"], 409: ["content_conflict"], 413: ["payload_too_large"],
  415: ["unsupported_media_type"], 429: ["rate_limited"], 503: ["storage_unavailable", "service_not_configured"],
};
function response(value: unknown, status: number) {
  return Response.json(value, { status, headers: {
    "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff",
    ...(status === 429 ? { "Retry-After": "60" } : {}),
  } });
}

export function telemetryPersistence(batch: TelemetryBatch, auth: { nonce: string; bodySha256: string }): TelemetryPersistence {
  return {
    producerId: batch.producerId, batchId: batch.batchId, ...auth,
    events: batch.events.map(original => {
      const event = { ...original, message: redactConsoleLogMessage(original.message) || "[REDACTED]" };
      if (original.actor) event.actor = { ...original.actor,
        ...(original.actor.displayName ? { displayName: redactConsoleLogMessage(original.actor.displayName) || "[REDACTED]" } : {}),
      };
      // Compare the original source event, but persist only the redacted copy.
      return { digest: canonicalEventDigest(original), event };
    }),
  };
}

export async function handleTelemetryRequest(request: Request, dependencies: TelemetryDependencies): Promise<Response> {
  try {
    if (!dependencies.enabled) throw new TelemetryError(404, "not_enabled");
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/api/agent/telemetry" || url.search) throw new TelemetryError(400, "invalid_payload");
    const now = dependencies.now?.() ?? Date.now();
    const raw = await readTelemetryBody(request);
    const auth = authenticateTelemetry(request.headers, raw, dependencies.secrets(), now);
    const batch = parseTelemetryBatch(raw, now);
    if (auth.producerId !== batch.producerId) throw new TelemetryError(401, "authentication_failed");
    const result = await dependencies.persist(telemetryPersistence(batch, auth));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new TelemetryError(503, "storage_unavailable");
    const row = result as { status?: unknown; receipt?: unknown; code?: unknown };
    if (row.status === 200 || row.status === 202) {
      const receipt: TelemetryReceipt = verifyTelemetryReceipt(row.receipt, batch);
      if (receipt.replayed !== (row.status === 200)) throw new TelemetryError(503, "storage_unavailable");
      return response(receipt, row.status);
    }
    if (typeof row.status === "number" && errorCodes[row.status]?.includes(row.code as TelemetryCode)) {
      throw new TelemetryError(row.status, row.code as TelemetryCode);
    }
    throw new TelemetryError(503, "storage_unavailable");
  } catch (error) {
    if (error instanceof TelemetryError) return response({ accepted: false, code: error.code }, error.status);
    // Payloads, credentials, database diagnostics and network details never leave here.
    return response({ accepted: false, code: "storage_unavailable" }, 503);
  }
}

export async function persistTelemetry(input: TelemetryPersistence): Promise<unknown> {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new TelemetryError(503, "service_not_configured");
  const result = await fetch(`${url}/rest/v1/rpc/ingest_operational_telemetry_v1`, {
    method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_producer_id: input.producerId, p_batch_id: input.batchId,
      p_nonce: input.nonce, p_body_sha256: input.bodySha256, p_events: input.events }),
    signal: AbortSignal.timeout(8_000), cache: "no-store",
  });
  if (!result.ok) throw new TelemetryError(503, "storage_unavailable");
  return result.json();
}
