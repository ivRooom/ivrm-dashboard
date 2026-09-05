import { NextResponse } from "next/server";
import {
  authenticateOperationAgent,
  OperationAgentAuthError,
  parseOperationAgentJson,
  readOperationAgentBody,
} from "../../../../../lib/operation-agent-auth";
import { classifyOperationInternalError } from "../../../../../lib/operation-internal-error";
import {
  acceptOperationAgentRequest,
  MC_MAIN_OPERATION_ACTIONS,
  MC_MAIN_OPERATION_SERVER_ID,
  transitionMcMainOperationJob,
  type McMainOperationAction,
} from "../../../../../lib/mc-main-operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = new Set<string>(MC_MAIN_OPERATION_ACTIONS);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEASE_OWNER_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9._:-]{1,120}$/;

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function validTransitionBody(body: Record<string, unknown>): body is Record<string, unknown> & {
  serverId: string;
  jobId: string;
  action: McMainOperationAction;
  expectedStatus: "leased" | "running";
  newStatus: "running" | "succeeded" | "failed";
  leaseOwner: string;
  requestId: string;
  details: Record<string, string>;
} {
  if (Object.keys(body).some((key) => ![
    "serverId", "jobId", "action", "expectedStatus", "newStatus", "leaseOwner", "requestId", "details",
  ].includes(key))) return false;
  if (
    body.serverId !== MC_MAIN_OPERATION_SERVER_ID ||
    typeof body.jobId !== "string" || !UUID_PATTERN.test(body.jobId) ||
    typeof body.action !== "string" || !ACTIONS.has(body.action) ||
    typeof body.expectedStatus !== "string" || !["leased", "running"].includes(body.expectedStatus) ||
    typeof body.newStatus !== "string" || !["running", "succeeded", "failed"].includes(body.newStatus) ||
    typeof body.leaseOwner !== "string" || !LEASE_OWNER_PATTERN.test(body.leaseOwner) ||
    typeof body.requestId !== "string" || !UUID_PATTERN.test(body.requestId) ||
    typeof body.details !== "object" || body.details === null || Array.isArray(body.details)
  ) return false;

  const details = body.details as Record<string, unknown>;
  if (Object.keys(details).some((key) => !["phase", "errorCode"].includes(key))) return false;
  if (typeof details.phase !== "string" || ![
    "executing", "health_gate_passed", "stopped", "execution_failed",
  ].includes(details.phase)) return false;
  if (details.errorCode !== undefined && (typeof details.errorCode !== "string" || !ERROR_CODE_PATTERN.test(details.errorCode))) {
    return false;
  }
  return true;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const rawBody = await readOperationAgentBody(request);
    const body = parseOperationAgentJson(rawBody);
    if (!validTransitionBody(body)) throw new OperationAgentAuthError(400, "invalid_payload");

    const auth = authenticateOperationAgent(request.headers, rawBody, MC_MAIN_OPERATION_SERVER_ID);
    const accepted = await acceptOperationAgentRequest({
      serverId: MC_MAIN_OPERATION_SERVER_ID,
      kind: "transition",
      nonce: auth.nonce,
      bodySha256: auth.bodySha256,
    });
    if (!accepted) return json({ accepted: false, error: "replayed_request" }, 409);

    await transitionMcMainOperationJob({
      serverId: MC_MAIN_OPERATION_SERVER_ID,
      jobId: body.jobId,
      action: body.action,
      expectedStatus: body.expectedStatus,
      newStatus: body.newStatus,
      leaseOwner: body.leaseOwner,
      requestId: body.requestId,
      details: body.details,
    });
    return json({ accepted: true, jobId: body.jobId, status: body.newStatus });
  } catch (error) {
    if (error instanceof OperationAgentAuthError) {
      return json({ accepted: false, error: error.code }, error.status);
    }
    const code = classifyOperationInternalError(error);
    console.error(`Operation Agent transition API internal_error code=${code}`);
    return json({ accepted: false, error: "internal_error" }, 500);
  }
}
