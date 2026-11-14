import {
  markReliabilityBurnReconcile,
  reconcileReliabilityBurnNotifications,
  verifyReliabilityBurnReconcileToken,
} from "../../../../lib/reliability-burn-notifications";
import { readLimitedBody as readSharedLimitedBody } from "../../../../lib/agent-ingest-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 1_024;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

const PAYLOAD_TOO_LARGE = new Error("payload_too_large");

async function readLimitedBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  try {
    return await readSharedLimitedBody(request, MAX_BODY_BYTES, () => PAYLOAD_TOO_LARGE);
  } catch (error) {
    if (error === PAYLOAD_TOO_LARGE) return null;
    throw error;
  }
}

export async function POST(request: Request): Promise<Response> {
  const body = await readLimitedBody(request);
  if (body === null) return json(413, { ok: false, error: "payload_too_large" });

  const token = request.headers.get("x-ivrm-reliability-token")?.trim() ?? "";
  let authorized = false;
  try {
    authorized = await verifyReliabilityBurnReconcileToken(token);
  } catch (error) {
    console.error("Burn Rate ReconcilerのToken検証に失敗しました", error);
    return json(503, { ok: false, error: "verification_unavailable" });
  }
  if (!authorized) return json(401, { ok: false, error: "unauthorized" });

  try {
    const result = await reconcileReliabilityBurnNotifications();
    await markReliabilityBurnReconcile(true, result.evaluated, null);
    return json(200, {
      ok: true,
      evaluated: result.evaluated,
      changed: result.changed,
      skipped: result.skipped,
      historyRecorded: result.historyRecorded,
      generatedAt: result.generatedAt,
    });
  } catch (error) {
    console.error("Burn Rate Reconcileに失敗しました", error);
    await markReliabilityBurnReconcile(false, 0, "reconcile_failed").catch((markError) => {
      console.error("Burn Rate Reconcile失敗状態の記録にも失敗しました", markError);
    });
    return json(500, { ok: false, error: "reconcile_failed" });
  }
}