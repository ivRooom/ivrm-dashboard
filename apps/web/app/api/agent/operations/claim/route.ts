import { randomUUID } from "node:crypto";
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
  claimMcMainOperationJob,
  MC_MAIN_OPERATION_SERVER_ID,
} from "../../../../../lib/mc-main-operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LEASE_OWNER_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const rawBody = await readOperationAgentBody(request);
    const body = parseOperationAgentJson(rawBody);
    if (
      Object.keys(body).some((key) => !["serverId", "leaseOwner"].includes(key)) ||
      body.serverId !== MC_MAIN_OPERATION_SERVER_ID ||
      typeof body.leaseOwner !== "string" ||
      !LEASE_OWNER_PATTERN.test(body.leaseOwner)
    ) {
      throw new OperationAgentAuthError(400, "invalid_payload");
    }

    const auth = authenticateOperationAgent(request.headers, rawBody, MC_MAIN_OPERATION_SERVER_ID);
    const accepted = await acceptOperationAgentRequest({
      serverId: MC_MAIN_OPERATION_SERVER_ID,
      kind: "claim",
      nonce: auth.nonce,
      bodySha256: auth.bodySha256,
    });
    if (!accepted) return json({ accepted: false, error: "replayed_request" }, 409);

    const job = await claimMcMainOperationJob({
      serverId: MC_MAIN_OPERATION_SERVER_ID,
      leaseOwner: body.leaseOwner,
      requestId: randomUUID(),
    });
    return json({ accepted: true, job }, 200);
  } catch (error) {
    if (error instanceof OperationAgentAuthError) {
      return json({ accepted: false, error: error.code }, error.status);
    }
    const code = classifyOperationInternalError(error);
    console.error(`Operation Agent claim API internal_error code=${code}`);
    return json({ accepted: false, error: "internal_error" }, 500);
  }
}
