import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_CONTAINERS = 20;
const MAX_CPU_PERCENT = 100_000;
const MAX_PIDS = 2_147_483_647;
const MAX_MINECRAFT_PLAYERS = 1_000_000;
const MAX_MINECRAFT_LATENCY_MS = 60_000;
const MAX_MINECRAFT_TPS = 1_000;
const MAX_MINECRAFT_MSPT_MS = 60_000;
export const MAX_HEARTBEAT_BODY_BYTES = 32 * 1024;

const containerStates = new Set([
  "created",
  "running",
  "paused",
  "restarting",
  "removing",
  "exited",
  "dead",
  "unknown",
  "not_found",
]);

const containerHealthStates = new Set([
  "starting",
  "healthy",
  "unhealthy",
  "none",
  "unknown",
]);

export type ContainerHeartbeat = {
  name: string;
  state: string;
  health: string;
  restartCount: number;
  oomKilled: boolean;
  exitCode: number | null;
  cpuPercent: number | null;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number | null;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
  blockReadBytes: number | null;
  blockWriteBytes: number | null;
  pids: number | null;
};

export type MinecraftEndpointHeartbeat = {
  reachable: boolean;
  latencyMs: number | null;
  version: string | null;
  online: number | null;
  max: number | null;
};

export type MinecraftPerformanceHeartbeat = {
  source: "spark";
  tps1m: number;
  tps5m: number;
  tps15m: number;
  msptMedian1m: number;
  msptP95_1m: number;
  msptMax1m: number;
};

export type MinecraftHeartbeat = {
  publicEndpoint: MinecraftEndpointHeartbeat;
  backend: MinecraftEndpointHeartbeat;
  proxyPortPublished: boolean;
  backendPortPublished: boolean;
  voiceChatPortPublished: boolean;
  performance: MinecraftPerformanceHeartbeat | null;
};

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
  containers: ContainerHeartbeat[];
  minecraft: MinecraftHeartbeat | null;
};

type PersistResult =
  | "accepted"
  | "unknown_agent"
  | "rate_limited"
  | "replayed_request"
  | "invalid_payload";

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

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function normalizeResourceMetrics(
  value: Record<string, unknown>,
): Pick<
  ContainerHeartbeat,
  | "cpuPercent"
  | "memoryUsageBytes"
  | "memoryLimitBytes"
  | "networkRxBytes"
  | "networkTxBytes"
  | "blockReadBytes"
  | "blockWriteBytes"
  | "pids"
> | null {
  const cpuPercent = value.cpuPercent ?? null;
  const memoryUsageBytes = value.memoryUsageBytes ?? null;
  const memoryLimitBytes = value.memoryLimitBytes ?? null;
  const networkRxBytes = value.networkRxBytes ?? null;
  const networkTxBytes = value.networkTxBytes ?? null;
  const blockReadBytes = value.blockReadBytes ?? null;
  const blockWriteBytes = value.blockWriteBytes ?? null;
  const pids = value.pids ?? null;

  const values = [
    cpuPercent,
    memoryUsageBytes,
    memoryLimitBytes,
    networkRxBytes,
    networkTxBytes,
    blockReadBytes,
    blockWriteBytes,
    pids,
  ];
  const presentCount = values.filter((metric) => metric !== null).length;
  if (presentCount !== 0 && presentCount !== values.length) {
    return null;
  }
  if (presentCount === 0) {
    return {
      cpuPercent: null,
      memoryUsageBytes: null,
      memoryLimitBytes: null,
      networkRxBytes: null,
      networkTxBytes: null,
      blockReadBytes: null,
      blockWriteBytes: null,
      pids: null,
    };
  }

  if (
    !isFiniteNonNegative(cpuPercent) ||
    cpuPercent > MAX_CPU_PERCENT ||
    !Number.isSafeInteger(memoryUsageBytes) ||
    Number(memoryUsageBytes) < 0 ||
    !Number.isSafeInteger(memoryLimitBytes) ||
    Number(memoryLimitBytes) < 0 ||
    Number(memoryUsageBytes) > Number(memoryLimitBytes) ||
    !Number.isSafeInteger(networkRxBytes) ||
    Number(networkRxBytes) < 0 ||
    !Number.isSafeInteger(networkTxBytes) ||
    Number(networkTxBytes) < 0 ||
    !Number.isSafeInteger(blockReadBytes) ||
    Number(blockReadBytes) < 0 ||
    !Number.isSafeInteger(blockWriteBytes) ||
    Number(blockWriteBytes) < 0 ||
    !Number.isSafeInteger(pids) ||
    Number(pids) < 0 ||
    Number(pids) > MAX_PIDS
  ) {
    return null;
  }

  return {
    cpuPercent,
    memoryUsageBytes: Number(memoryUsageBytes),
    memoryLimitBytes: Number(memoryLimitBytes),
    networkRxBytes: Number(networkRxBytes),
    networkTxBytes: Number(networkTxBytes),
    blockReadBytes: Number(blockReadBytes),
    blockWriteBytes: Number(blockWriteBytes),
    pids: Number(pids),
  };
}

function normalizeContainerHeartbeat(value: unknown): ContainerHeartbeat | null {
  if (!isRecord(value)) {
    return null;
  }

  const resources = normalizeResourceMetrics(value);
  if (
    resources === null ||
    typeof value.name !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value.name) ||
    typeof value.state !== "string" ||
    !containerStates.has(value.state) ||
    typeof value.health !== "string" ||
    !containerHealthStates.has(value.health) ||
    !Number.isInteger(value.restartCount) ||
    Number(value.restartCount) < 0 ||
    typeof value.oomKilled !== "boolean" ||
    (value.exitCode !== null && !Number.isInteger(value.exitCode))
  ) {
    return null;
  }

  return {
    name: value.name,
    state: value.state,
    health: value.health,
    restartCount: Number(value.restartCount),
    oomKilled: value.oomKilled,
    exitCode: value.exitCode === null ? null : Number(value.exitCode),
    ...resources,
  };
}

function normalizeContainers(value: unknown): ContainerHeartbeat[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_CONTAINERS) {
    return null;
  }

  const seen = new Set<string>();
  const containers: ContainerHeartbeat[] = [];
  for (const valueItem of value) {
    const container = normalizeContainerHeartbeat(valueItem);
    if (!container || seen.has(container.name)) {
      return null;
    }
    seen.add(container.name);
    containers.push(container);
  }
  return containers;
}

function normalizeMinecraftEndpoint(
  value: unknown,
): MinecraftEndpointHeartbeat | null {
  if (!isRecord(value) || typeof value.reachable !== "boolean") {
    return null;
  }

  const latencyMs = value.latencyMs ?? null;
  const version = value.version ?? null;
  const online = value.online ?? null;
  const maximum = value.max ?? null;

  if (!value.reachable) {
    if (
      latencyMs !== null ||
      version !== null ||
      online !== null ||
      maximum !== null
    ) {
      return null;
    }
    return {
      reachable: false,
      latencyMs: null,
      version: null,
      online: null,
      max: null,
    };
  }

  if (typeof version !== "string") {
    return null;
  }
  const normalizedVersion = version.trim();
  if (
    !Number.isInteger(latencyMs) ||
    Number(latencyMs) < 0 ||
    Number(latencyMs) > MAX_MINECRAFT_LATENCY_MS ||
    normalizedVersion.length < 1 ||
    unicodeLength(normalizedVersion) > 128 ||
    !Number.isInteger(online) ||
    Number(online) < 0 ||
    !Number.isInteger(maximum) ||
    Number(maximum) < 1 ||
    Number(maximum) > MAX_MINECRAFT_PLAYERS ||
    Number(online) > Number(maximum)
  ) {
    return null;
  }

  return {
    reachable: true,
    latencyMs: Number(latencyMs),
    version: normalizedVersion,
    online: Number(online),
    max: Number(maximum),
  };
}

function normalizeMinecraftPerformance(
  value: unknown,
): MinecraftPerformanceHeartbeat | null {
  if (!isRecord(value) || value.source !== "spark") {
    return null;
  }

  const metrics = [
    value.tps1m,
    value.tps5m,
    value.tps15m,
    value.msptMedian1m,
    value.msptP95_1m,
    value.msptMax1m,
  ];
  if (
    metrics.some((metric) => !isFiniteNonNegative(metric)) ||
    Number(value.tps1m) > MAX_MINECRAFT_TPS ||
    Number(value.tps5m) > MAX_MINECRAFT_TPS ||
    Number(value.tps15m) > MAX_MINECRAFT_TPS ||
    Number(value.msptMedian1m) > MAX_MINECRAFT_MSPT_MS ||
    Number(value.msptP95_1m) > MAX_MINECRAFT_MSPT_MS ||
    Number(value.msptMax1m) > MAX_MINECRAFT_MSPT_MS ||
    Number(value.msptMedian1m) > Number(value.msptP95_1m) ||
    Number(value.msptP95_1m) > Number(value.msptMax1m)
  ) {
    return null;
  }

  return {
    source: "spark",
    tps1m: Number(value.tps1m),
    tps5m: Number(value.tps5m),
    tps15m: Number(value.tps15m),
    msptMedian1m: Number(value.msptMedian1m),
    msptP95_1m: Number(value.msptP95_1m),
    msptMax1m: Number(value.msptMax1m),
  };
}

function normalizeMinecraft(value: unknown): MinecraftHeartbeat | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }

  const publicEndpoint = normalizeMinecraftEndpoint(value.publicEndpoint);
  const backend = normalizeMinecraftEndpoint(value.backend);
  const performanceProvided = value.performance !== undefined && value.performance !== null;
  const performance = performanceProvided
    ? normalizeMinecraftPerformance(value.performance)
    : null;
  if (
    !publicEndpoint ||
    !backend ||
    (performanceProvided && !performance) ||
    typeof value.proxyPortPublished !== "boolean" ||
    typeof value.backendPortPublished !== "boolean" ||
    typeof value.voiceChatPortPublished !== "boolean"
  ) {
    return null;
  }

  return {
    publicEndpoint,
    backend,
    proxyPortPublished: value.proxyPortPublished,
    backendPortPublished: value.backendPortPublished,
    voiceChatPortPublished: value.voiceChatPortPublished,
    performance,
  };
}

function parseHeartbeatValue(value: unknown): HeartbeatPayload | null {
  if (!isRecord(value) || !isRecord(value.host)) {
    return null;
  }

  const host = value.host;
  const containers = normalizeContainers(value.containers);
  const minecraft = normalizeMinecraft(value.minecraft);
  const minecraftProvided =
    value.minecraft !== undefined && value.minecraft !== null;
  if (containers === null || (minecraftProvided && minecraft === null)) {
    return null;
  }

  if (
    typeof value.serverId !== "string" ||
    !/^[a-zA-Z0-9._-]{1,64}$/.test(value.serverId) ||
    typeof value.agentVersion !== "string" ||
    value.agentVersion.length < 1 ||
    value.agentVersion.length > 32 ||
    typeof value.sentAt !== "string" ||
    !Number.isInteger(host.cpuCount) ||
    Number(host.cpuCount) <= 0 ||
    !isFiniteNonNegative(host.memoryTotalBytes) ||
    !isFiniteNonNegative(host.memoryAvailableBytes) ||
    host.memoryAvailableBytes > host.memoryTotalBytes ||
    !isFiniteNonNegative(host.diskTotalBytes) ||
    !isFiniteNonNegative(host.diskAvailableBytes) ||
    host.diskAvailableBytes > host.diskTotalBytes ||
    !isFiniteNonNegative(host.loadAverage1) ||
    !isFiniteNonNegative(host.loadAverage5) ||
    !isFiniteNonNegative(host.loadAverage15) ||
    !isFiniteNonNegative(host.uptimeSeconds)
  ) {
    return null;
  }

  return {
    serverId: value.serverId,
    agentVersion: value.agentVersion,
    sentAt: value.sentAt,
    host: {
      cpuCount: Number(host.cpuCount),
      memoryTotalBytes: host.memoryTotalBytes,
      memoryAvailableBytes: host.memoryAvailableBytes,
      diskTotalBytes: host.diskTotalBytes,
      diskAvailableBytes: host.diskAvailableBytes,
      loadAverage1: host.loadAverage1,
      loadAverage5: host.loadAverage5,
      loadAverage15: host.loadAverage15,
      uptimeSeconds: host.uptimeSeconds,
    },
    containers,
    minecraft,
  };
}

export function parseHeartbeat(rawBody: Uint8Array): HeartbeatPayload {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    throw new HeartbeatError(400, "invalid_json");
  }

  const parsed = parseHeartbeatValue(value);
  if (!parsed) {
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
    case "invalid_payload":
      throw new HeartbeatError(400, result);
  }
}

export async function persistHeartbeat(
  payload: HeartbeatPayload,
  nonce: string,
  bodySha256: string,
): Promise<void> {
  const { url, serviceRoleKey } = getSupabaseConfiguration();
  const response = await fetch(`${url}/rest/v1/rpc/insert_agent_heartbeat_v3`, {
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
      p_containers: payload.containers,
      p_minecraft: payload.minecraft,
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
    result !== "replayed_request" &&
    result !== "invalid_payload"
  ) {
    throw new HeartbeatError(503, "storage_unavailable");
  }
  handlePersistResult(result);
}
