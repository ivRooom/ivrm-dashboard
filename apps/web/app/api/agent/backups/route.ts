import {
  authenticateBackupReport,
  BackupReportError,
  MAX_BACKUP_REPORT_BODY_BYTES,
  parseBackupReport,
  persistBackupReport,
} from "../../../../lib/backup-report";
import { readLimitedBody } from "../../../../lib/agent-ingest-body";
import { agentIngestErrorResponse, agentIngestJson } from "../../../../lib/agent-ingest-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_POLICY = { retryAfterSeconds: 2 };

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new BackupReportError(415, "unsupported_media_type");
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BACKUP_REPORT_BODY_BYTES) {
      throw new BackupReportError(413, "payload_too_large");
    }

    const rawBody = await readLimitedBody(request, MAX_BACKUP_REPORT_BODY_BYTES, () =>
      new BackupReportError(413, "payload_too_large"),
    );
    if (rawBody.byteLength === 0) throw new BackupReportError(400, "empty_payload");

    const payload = parseBackupReport(rawBody);
    const auth = authenticateBackupReport(request.headers, rawBody, payload);
    await persistBackupReport(payload, auth.nonce, auth.bodySha256);

    return agentIngestJson(
      { accepted: true, receivedAt: new Date().toISOString(), runs: payload.runs.length },
      202,
      RESPONSE_POLICY,
    );
  } catch (error) {
    const response = agentIngestErrorResponse(error, RESPONSE_POLICY);
    if (response) return response;

    console.error("Backup Report APIで予期しないエラーが発生しました");
    return agentIngestJson({ accepted: false, error: "internal_error" }, 500, RESPONSE_POLICY);
  }
}
