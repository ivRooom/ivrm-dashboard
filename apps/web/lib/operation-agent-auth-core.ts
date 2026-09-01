import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const MAX_CLOCK_SKEW_SECONDS = 300;
export const MAX_OPERATION_AGENT_BODY_BYTES = 4 * 1024;

export class OperationAgentAuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function parseAgentSecretMap(raw: string | undefined): Record<string, string> {
  if (!raw) throw new OperationAgentAuthError(503, "service_not_configured");
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    const result: Record<string, string> = {};
    for (const [serverId, secret] of Object.entries(value)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(serverId) || typeof secret !== "string" || secret.length < 32) {
        throw new Error();
      }
      result[serverId] = secret;
    }
    return result;
  } catch (error) {
    if (error instanceof OperationAgentAuthError) throw error;
    throw new OperationAgentAuthError(503, "service_not_configured");
  }
}

export function parseOperationAgentJson(rawBody: Uint8Array): Record<string, unknown> {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new OperationAgentAuthError(400, "invalid_payload");
  }
}

export function authenticateOperationAgentWithSecrets(
  headers: Headers,
  rawBody: Uint8Array,
  expectedServerId: string,
  secrets: Record<string, string>,
  nowMilliseconds = Date.now(),
): { nonce: string; bodySha256: string } {
  const serverId = headers.get("x-ivrm-agent-id") ?? "";
  const timestamp = headers.get("x-ivrm-timestamp") ?? "";
  const nonce = headers.get("x-ivrm-nonce") ?? "";
  const signature = headers.get("x-ivrm-signature") ?? "";

  if (serverId !== expectedServerId || !/^[A-Za-z0-9._-]{1,64}$/.test(serverId)) {
    throw new OperationAgentAuthError(401, "agent_id_mismatch");
  }
  if (!/^\d{10}$/.test(timestamp)) throw new OperationAgentAuthError(401, "invalid_timestamp");
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(nowMilliseconds / 1_000 - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS) {
    throw new OperationAgentAuthError(401, "expired_request");
  }
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new OperationAgentAuthError(401, "invalid_nonce");
  if (!/^[a-f0-9]{64}$/.test(signature)) throw new OperationAgentAuthError(401, "invalid_signature");

  const secret = secrets[serverId];
  if (!secret) throw new OperationAgentAuthError(401, "unknown_agent");
  const expected = createHmac("sha256", secret)
    .update(timestamp).update(".").update(nonce).update(".").update(rawBody).digest();
  const provided = Buffer.from(signature, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new OperationAgentAuthError(401, "invalid_signature");
  }
  return {
    nonce,
    bodySha256: createHash("sha256").update(rawBody).digest("hex"),
  };
}
