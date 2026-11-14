import { authenticateHeartbeat } from "../../../../lib/heartbeat";
import { parseRuntimeInventory, runtimeOnlySecrets } from "../../../../lib/runtime-inventory-core";
import { authenticateOperationAgentWithSecrets } from "../../../../lib/operation-agent-auth-core";
import { ingestRuntimeInventory, runtimeInventoryEnabled } from "../../../../lib/runtime-inventory";
import {
  agentIngestErrorResponse,
  agentIngestJson,
  type AgentIngestResponsePolicy,
} from "../../../../lib/agent-ingest-response";

const RESPONSE_POLICY: AgentIngestResponsePolicy = {};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const respond = (status: number, error: string) =>
    agentIngestJson({ accepted: false, error }, status, RESPONSE_POLICY);
  if (!runtimeInventoryEnabled()) return respond(404, "not_enabled");
  try {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return respond(415, "unsupported_media_type");
    if (Number(request.headers.get("content-length")) > 32768) return respond(413, "payload_too_large");
    const reader = request.body?.getReader();
    if (!reader) return respond(400, "empty_payload");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > 32768) { await reader.cancel(); return respond(413, "payload_too_large"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const raw = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
    let payload;
    try { payload = parseRuntimeInventory(raw); } catch { return respond(400, "invalid_payload"); }
    let auth;
    if (payload.serverId === "lightsail-herta") {
      let secrets;
      try { secrets = runtimeOnlySecrets(payload.serverId, process.env.IVRM_RUNTIME_HERTA_SECRET); }
      catch { return respond(503, "service_not_configured"); }
      auth = authenticateOperationAgentWithSecrets(request.headers, raw, payload.serverId, secrets);
    } else {
      auth = authenticateHeartbeat(request.headers, raw, payload);
    }
    const result = await ingestRuntimeInventory(payload, auth.nonce);
    if (result === "accepted") return agentIngestJson({ accepted: true }, 202, RESPONSE_POLICY);
    const codes: Record<string, number> = { unknown_agent: 401, target_not_allowed: 403, replayed_request: 409, rate_limited: 429, invalid_payload: 400 };
    return respond(typeof result === "string" ? codes[result] ?? 503 : 503, typeof result === "string" && Object.hasOwn(codes, result) ? result : "store_unavailable");
  } catch (error) {
    const response = agentIngestErrorResponse(error, RESPONSE_POLICY);
    if (response) return response;
    return respond(503, "store_unavailable");
  }
}
