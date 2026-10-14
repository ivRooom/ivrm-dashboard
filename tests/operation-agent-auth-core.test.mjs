import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  authenticateOperationAgentWithSecrets,
  OperationAgentAuthError,
  parseAgentSecretMaps,
} from "../apps/web/lib/operation-agent-auth-core.ts";

const SERVER_ID = "oci-minecraft-01";
const SECRET = "0123456789abcdef0123456789abcdef";
const BODY = new TextEncoder().encode('{"serverId":"oci-minecraft-01"}');
const NOW = 1_788_250_000_000;

test("additional Secret preserves old credentials and authenticates a new agent", () => {
  const secrets = parseAgentSecretMaps(JSON.stringify({ legacy: "x".repeat(32) }), JSON.stringify({ [SERVER_ID]: SECRET }));
  assert.equal(secrets.legacy, "x".repeat(32));
  assert.equal(authenticateOperationAgentWithSecrets(headers(), BODY, SERVER_ID, secrets, NOW).nonce.length, 32);
});

test("additional Secret cannot override an existing agent, even with the same value", () => {
  const raw = JSON.stringify({ [SERVER_ID]: SECRET });
  assert.equal(errorCode(() => parseAgentSecretMaps(raw, raw)), "service_not_configured");
  assert.equal(errorCode(() => parseAgentSecretMaps(raw, JSON.stringify({ other: "short" }))), "service_not_configured");
});

test("omitting additional Secret keeps the original map usable", () => {
  assert.deepEqual(parseAgentSecretMaps(JSON.stringify({ [SERVER_ID]: SECRET })), { [SERVER_ID]: SECRET });
});

function headers(input = {}) {
  const timestamp = input.timestamp ?? String(Math.floor(NOW / 1_000));
  const nonce = input.nonce ?? "0123456789abcdef0123456789abcdef";
  const signature = input.signature ?? createHmac("sha256", SECRET)
    .update(timestamp).update(".").update(nonce).update(".").update(BODY).digest("hex");
  return new Headers({
    "X-IVRM-Agent-ID": input.serverId ?? SERVER_ID,
    "X-IVRM-Timestamp": timestamp,
    "X-IVRM-Nonce": nonce,
    "X-IVRM-Signature": signature,
  });
}

function errorCode(fn) {
  try {
    fn();
    assert.fail("expected authentication failure");
  } catch (error) {
    assert.ok(error instanceof OperationAgentAuthError);
    return error.code;
  }
}

test("valid HMAC is accepted", () => {
  const result = authenticateOperationAgentWithSecrets(headers(), BODY, SERVER_ID, { [SERVER_ID]: SECRET }, NOW);
  assert.equal(result.nonce, "0123456789abcdef0123456789abcdef");
  assert.match(result.bodySha256, /^[a-f0-9]{64}$/);
});

test("invalid HMAC is rejected", () => {
  assert.equal(errorCode(() => authenticateOperationAgentWithSecrets(
    headers({ signature: "0".repeat(64) }), BODY, SERVER_ID, { [SERVER_ID]: SECRET }, NOW,
  )), "invalid_signature");
});

test("expired timestamp is rejected", () => {
  const timestamp = String(Math.floor(NOW / 1_000) - 301);
  assert.equal(errorCode(() => authenticateOperationAgentWithSecrets(
    headers({ timestamp }), BODY, SERVER_ID, { [SERVER_ID]: SECRET }, NOW,
  )), "expired_request");
});

test("agent ID mismatch is rejected", () => {
  assert.equal(errorCode(() => authenticateOperationAgentWithSecrets(
    headers({ serverId: "other-agent" }), BODY, SERVER_ID, { [SERVER_ID]: SECRET }, NOW,
  )), "agent_id_mismatch");
});
