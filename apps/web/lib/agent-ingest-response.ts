import { NextResponse } from "next/server";
import { AgentIngestError } from "./operation-agent-auth-core";

export type AgentIngestResponsePolicy = {
  retryAfterSeconds?: number;
};

export function agentIngestHeaders(
  status: number,
  policy: AgentIngestResponsePolicy = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
  };
  if (status === 429 && policy.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(policy.retryAfterSeconds);
  }
  return headers;
}

export function agentIngestJson(
  body: unknown,
  status: number,
  policy: AgentIngestResponsePolicy = {},
): NextResponse {
  return NextResponse.json(body, { status, headers: agentIngestHeaders(status, policy) });
}

export function agentIngestErrorResponse(
  error: unknown,
  policy: AgentIngestResponsePolicy = {},
): NextResponse | null {
  if (error instanceof AgentIngestError) {
    return agentIngestJson({ accepted: false, error: error.code }, error.status, policy);
  }
  return null;
}
