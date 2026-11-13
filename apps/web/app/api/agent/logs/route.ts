import { NextResponse } from "next/server";
import {
  authenticateLogReport,
  LogReportError,
  MAX_LOG_REPORT_BODY_BYTES,
  parseLogReport,
  persistLogReport,
} from "../../../../lib/log-report";
import { readLimitedBody } from "../../../../lib/agent-ingest-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new LogReportError(415, "unsupported_media_type");
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_LOG_REPORT_BODY_BYTES) {
      throw new LogReportError(413, "payload_too_large");
    }

    const rawBody = await readLimitedBody(request, MAX_LOG_REPORT_BODY_BYTES, () =>
      new LogReportError(413, "payload_too_large"),
    );
    if (rawBody.byteLength === 0) throw new LogReportError(400, "empty_payload");

    const payload = parseLogReport(rawBody);
    const auth = authenticateLogReport(request.headers, rawBody, payload);
    await persistLogReport(payload, auth.nonce, auth.bodySha256);

    return NextResponse.json(
      { accepted: true, receivedAt: new Date().toISOString(), entries: payload.entries.length },
      {
        status: 202,
        headers: {
          "Cache-Control": "no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    if (error instanceof LogReportError) {
      return NextResponse.json(
        { accepted: false, error: error.code },
        {
          status: error.status,
          headers: {
            "Cache-Control": "no-store, max-age=0",
            "X-Content-Type-Options": "nosniff",
            ...(error.status === 429 ? { "Retry-After": "2" } : {}),
          },
        },
      );
    }

    console.error("Log Report APIで予期しないエラーが発生しました");
    return NextResponse.json(
      { accepted: false, error: "internal_error" },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
}
