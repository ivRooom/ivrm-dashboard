import { NextResponse } from "next/server";
import {
  authenticateHeartbeat,
  HeartbeatError,
  MAX_HEARTBEAT_BODY_BYTES,
  parseHeartbeat,
  persistHeartbeat,
} from "../../../../lib/heartbeat";
import { readLimitedBody } from "../../../../lib/agent-ingest-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new HeartbeatError(415, "unsupported_media_type");
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_HEARTBEAT_BODY_BYTES) {
      throw new HeartbeatError(413, "payload_too_large");
    }

    const rawBody = await readLimitedBody(request, MAX_HEARTBEAT_BODY_BYTES, () =>
      new HeartbeatError(413, "payload_too_large"),
    );
    if (rawBody.byteLength === 0) {
      throw new HeartbeatError(400, "empty_payload");
    }

    const payload = parseHeartbeat(rawBody);
    const authentication = authenticateHeartbeat(request.headers, rawBody, payload);
    await persistHeartbeat(payload, authentication.nonce, authentication.bodySha256);

    return NextResponse.json(
      { accepted: true, receivedAt: new Date().toISOString() },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof HeartbeatError) {
      return NextResponse.json(
        { accepted: false, error: error.code },
        {
          status: error.status,
          headers: error.status === 429 ? { "Retry-After": "10" } : undefined,
        },
      );
    }

    console.error("Heartbeat APIで予期しないエラーが発生しました");
    return NextResponse.json(
      { accepted: false, error: "internal_error" },
      { status: 500 },
    );
  }
}
