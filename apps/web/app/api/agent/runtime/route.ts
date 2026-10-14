import { NextResponse } from "next/server";
import { authenticateHeartbeat, HeartbeatError } from "../../../../lib/heartbeat";
import { parseRuntimeInventory } from "../../../../lib/runtime-inventory-core";
import { ingestRuntimeInventory, runtimeInventoryEnabled } from "../../../../lib/runtime-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const respond = (status: number, error: string) => NextResponse.json({ accepted: false, error }, { status, headers: { "Cache-Control": "no-store" } });
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
    const auth = authenticateHeartbeat(request.headers, raw, payload);
    const result = await ingestRuntimeInventory(payload, auth.nonce);
    if (result === "accepted") return NextResponse.json({ accepted: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
    const codes: Record<string, number> = { unknown_agent: 401, target_not_allowed: 403, replayed_request: 409, rate_limited: 429, invalid_payload: 400 };
    return respond(typeof result === "string" ? codes[result] ?? 503 : 503, typeof result === "string" && Object.hasOwn(codes, result) ? result : "store_unavailable");
  } catch (error) {
    if (error instanceof HeartbeatError) return respond(error.status, error.code);
    return respond(503, "store_unavailable");
  }
}
