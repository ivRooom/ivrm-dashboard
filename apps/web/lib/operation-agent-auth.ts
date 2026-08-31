import "server-only";

import {
  authenticateOperationAgentWithSecrets,
  MAX_OPERATION_AGENT_BODY_BYTES,
  OperationAgentAuthError,
  parseAgentSecretMap,
  parseOperationAgentJson,
} from "./operation-agent-auth-core";

export { MAX_OPERATION_AGENT_BODY_BYTES, OperationAgentAuthError, parseOperationAgentJson };

export async function readOperationAgentBody(request: Request): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new OperationAgentAuthError(415, "unsupported_media_type");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_OPERATION_AGENT_BODY_BYTES) {
    throw new OperationAgentAuthError(413, "payload_too_large");
  }
  if (!request.body) throw new OperationAgentAuthError(400, "empty_payload");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_OPERATION_AGENT_BODY_BYTES) {
        await reader.cancel("payload_too_large").catch(() => undefined);
        throw new OperationAgentAuthError(413, "payload_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new OperationAgentAuthError(400, "empty_payload");
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function authenticateOperationAgent(
  headers: Headers,
  rawBody: Uint8Array,
  expectedServerId: string,
): { nonce: string; bodySha256: string } {
  return authenticateOperationAgentWithSecrets(
    headers,
    rawBody,
    expectedServerId,
    parseAgentSecretMap(process.env.IVRM_AGENT_SECRETS_JSON),
  );
}
