import { authenticateHeartbeat } from "../../../../lib/heartbeat";
import { parseCloudEnvelope } from "../../../../lib/cloud-monitor-core";
import { ingestCloudMonitor } from "../../../../lib/cloud-monitor";
import { agentIngestErrorResponse, agentIngestJson } from "../../../../lib/agent-ingest-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BYTES = 16 * 1024;
const RESPONSE_POLICY = { retryAfterSeconds: 15 };

export async function POST(request: Request) {
  const respond = (status: number, error: string) =>
    agentIngestJson({ accepted: false, error }, status, RESPONSE_POLICY);
  try {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return respond(415, "unsupported_media_type");
    if (Number(request.headers.get("content-length")) > MAX_BYTES) return respond(413, "payload_too_large");
    const reader = request.body?.getReader();
    if (!reader) return respond(400, "empty_payload");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); return respond(413, "payload_too_large"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const raw = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
    let payload;
    try { payload = parseCloudEnvelope(raw); } catch { return respond(400, "invalid_payload"); }
    const auth = authenticateHeartbeat(request.headers, raw, payload);
    const result = await ingestCloudMonitor(payload, auth.nonce, auth.bodySha256);
    if (result === "accepted") return agentIngestJson({ accepted: true }, 202, RESPONSE_POLICY);
    const statuses: Record<string, number> = { unknown_agent: 401, target_not_allowed: 403, replayed_request: 409, rate_limited: 429, invalid_payload: 400 };
    return respond(statuses[result] ?? 503, result in statuses ? result : "store_unavailable");
  } catch (error) {
    const response = agentIngestErrorResponse(error, RESPONSE_POLICY);
    if (response) return response;
    console.error("Cloud Monitor取り込み失敗");
    return respond(503, "store_unavailable");
  }
}
