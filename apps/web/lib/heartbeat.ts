import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

const MAX_CLOCK_SKEW_SECONDS = 300;
export const MAX_HEARTBEAT_BODY_BYTES = 32 * 1024;

export type HeartbeatPayload = {
  serverId: string;
  agentVersion: string;
  sentAt: string;
  host: {
    cpuCount: number;
    memoryTotalBytes: number;
    memoryAvailableBytes: number;
    diskTotalBytes: number;
    diskAvailableBytes: number;
    loadAverage1: number;
    loadAverage5: number;
    loadAverage15: number;
    uptimeSeconds: number;
  };
};

type PersistResult =
  | "accepted"
  | "unknown_agent"
  | "rate_limited"
  | "replayed_request";

export class HeartbeatError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new HeartbeatError(503, "service_not_configured");
  }
  return value;
}

function readAgentSecrets(): Record<string, string> {
  const raw = requireEnvironment("IVRM_AGENT_SECRETS_JSON");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error("Agent secret map must be an object");
    }

    const secrets: Record<string, string> = {};
    for (const [serverId, value] of Object.entries(parsed)) {
      if (typeof value !== "string" || value.length < 32) {
        throw new Error(`Agent secret is invalid: ${serverId}`);
      }
      secrets[serverId] = value;
    }
    return secrets;
  } catch {
    throw new HeartbeatError(503, "service_not_configured");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isHeartbeatPayload(value: unknown): value is HeartbeatPayload {
  if (!isRecord(value) || !isRecord(value.host)) {
    return false;
  }

  const host = value.host;
  return (
    typeof value.serverId === "string" &&
    /^[a-zA-Z0-9._-]{1,64}$/.test(value.serverId) &&
    typeof value.agentVersion === "string" &&
    value.agentVersion.length >= 1 &&
    value.agentVersion.length <= 32 &&
    typeof value.sentAt === "string" &&
    Number.isInteger(host.cpuCount) &&
    Number(host.cpuCount) > 0 &&
    isFiniteNonNegative(host.memoryTotalBytes) &&
    isFiniteNonNegative(host.memoryAvailableBytes) &&
    host.memoryAvailableBytes <= host.memoryTotalBytes &&
    isFiniteNonNegative(host.diskTotalBytes) &&
    isFiniteNonNegative(host.diskAvailableBytes) &&
    host.diskAvailableBytes <= host.diskTotalBytes &&
    isFiniteNonNegative(host.loadAverage1) &&
    isFiniteNonNegative(host.loadAverage5) &&
    isFiniteNonNegative(host.loadAverage15) &&
    isFiniteNonNegative(host.uptimeSeconds)
  );
}

export function parseHeartbeat(rawBody: Uint8Array): HeartbeatPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    throw new HeartbeatError(400, "invalid_json");
  }

  if (!isHeartbeatPayload(parsed)) {
    throw new HeartbeatError(400, "invalid_payload");
  }

  const sentAt = Date.parse(parsed.sentAt);
  if (!Number.isFinite(sentAt)) {
    throw new HeartbeatError(400, "invalid_sent_at");
  }
  if (Math.abs(Date.now() - sentAt) > MAX_CLOCK_SKEW_SECONDS * 1_000) {
    throw new HeartbeatError(401, "expired_request");
  }

  return parsed;
}

export function authenticateHeartbeat(
  headers: Headers,
  rawBody: Uint8Array,
  payload: HeartbeatPayload,
): { nonce: string; bodySha256: string } {
  const serverId = headers.get("x-ivrm-agent-id") ?? "";
  const timestamp = headers.get("x-ivrm-timestamp") ?? "";
  const nonce = headers.get("x-ivrm-nonce") ?? "";
  const signature = headers.get("x-ivrm-signature") ?? "";

  if (serverId !== payload.serverId) {
    throw new HeartbeatError(401, "agent_id_mismatch");
  }
  if (!/^\d{10}$/.test(timestamp)) {
    throw new HeartbeatError(401, "invalid_timestamp");
  }
  const timestampSeconds = Number(timestamp);
  if (Math.abs(Date.now() / 1_000 - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS) {
    throw new HeartbeatError(401, "expired_request");
  }
  if (!/^[a-f0-9]{32}$/.test(nonce)) {
    throw new HeartbeatError(401, "invalid_nonce");
  }
  if (!/^[a-f0-9]{64}$/.test(signature)) {
    throw new HeartbeatError(401, "invalid_signature");
  }

  const secret = readAgentSecrets()[serverId];
  if (!secret) {
    throw new HeartbeatError(401, "unknown_agent");
  }

  const expected = createHmac("sha256", secret)
    .update(timestamp)
    .update(".")
    .update(nonce)
    .update(".")
    .update(rawBody)
    .digest();
  const provided = Buffer.from(signature, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new HeartbeatError(401, "invalid_signature");
  }

  return {
    nonce,
    bodySha256: createHash("sha256").update(rawBody).digest("hex"),
  };
}

function getSupabaseConfiguration(): { url: string; serviceRoleKey: string } {
  return {
    url: requireEnvironment("SUPABASE_URL").replace(/\/$/, ""),
    serviceRoleKey: requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

function supabaseHeaders(serviceRoleKey: string): HeadersInit {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

function handlePersistResult(result: PersistResult): void {
  switch (result) {
    case "accepted":
      return;
    case "unknown_agent":
      throw new HeartbeatError(401, result);
    case "rate_limited":
      throw new HeartbeatError(429, result);
    case "replayed_request":
      throw new HeartbeatError(409, result);
  }
}

export async function persistHeartbeat(
  payload: HeartbeatPayload,
  nonce: string,
  bodySha256: string,
): Promise<void> {
  const { url, serviceRoleKey } = getSupabaseConfiguration();
  const response = await fetch(`${url}/rest/v1/rpc/insert_agent_heartbeat`, {
    method: "POST",
    headers: supabaseHeaders(serviceRoleKey),
    body: JSON.stringify({
      p_server_id: payload.serverId,
      p_agent_version: payload.agentVersion,
      p_sent_at: payload.sentAt,
      p_request_nonce: nonce,
      p_body_sha256: bodySha256,
      p_cpu_count: payload.host.cpuCount,
      p_memory_total_bytes: payload.host.memoryTotalBytes,
      p_memory_available_bytes: payload.host.memoryAvailableBytes,
      p_disk_total_bytes: payload.host.diskTotalBytes,
      p_disk_available_bytes: payload.host.diskAvailableBytes,
      p_load_average_1: payload.host.loadAverage1,
      p_load_average_5: payload.host.loadAverage5,
      p_load_average_15: payload.host.loadAverage15,
      p_uptime_seconds: payload.host.uptimeSeconds,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new HeartbeatError(503, "storage_unavailable");
  }

  const result = (await response.json()) as PersistResult;
  if (
    result !== "accepted" &&
    result !== "unknown_agent" &&
    result !== "rate_limited" &&
    result !== "replayed_request"
  ) {
    throw new HeartbeatError(503, "storage_unavailable");
  }
  handlePersistResult(result);
}
