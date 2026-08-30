import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import {
  getConsoleLogSource,
  isConsoleLogLevel,
  type ConsoleLogLevel,
  type ConsoleLogSourceName,
  type ConsoleLogSourceType,
} from "./console-log-types";

const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_ENTRIES = 120;
const MAX_MESSAGE_CHARACTERS = 2048;
const MAX_RAW_MESSAGE_CHARACTERS = 4096;
const RFC3339_MICRO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const REPORT_KEYS = new Set(["serverId", "reportedAt", "entries"]);
const ENTRY_KEYS = new Set(["sourceType", "sourceName", "observedAt", "level", "message"]);
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const MINECRAFT_FORMAT_PATTERN = /§[0-9A-FK-ORX]/gi;
const IPV4_PATTERN = /(?<![0-9.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![0-9.])/g;
const IPV6_PATTERN = /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Fa-f:])/g;
const IPV6_CANDIDATE_PATTERN = /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Fa-f:])/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SECRET_QUERY_PATTERN = /([?&](?:access[_-]?token|refresh[_-]?token|token|password|passwd|secret|rcon[_-]?password|forwarding[_-]?secret)=)[^&\s]+/gi;
const SECRET_QUOTED_ASSIGNMENT_PATTERN = /\b(authorization|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|rcon(?:[._-]?password)?|forwarding(?:[._-]?secret))\b(["']?)(\s*[:=]\s*|\s+)(["'])([^"']*)\4/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(authorization|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|rcon(?:[._-]?password)?|forwarding(?:[._-]?secret))\b(["']?)(\s*[:=]\s*|\s+)([^\s,;}"']+)/gi;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/g;

export const MAX_LOG_REPORT_BODY_BYTES = 64 * 1024;

export type LogReportEntry = {
  eventId: string;
  sourceType: ConsoleLogSourceType;
  sourceName: ConsoleLogSourceName;
  observedAt: string;
  level: ConsoleLogLevel;
  message: string;
};

export type LogReportPayload = {
  serverId: string;
  reportedAt: string;
  entries: LogReportEntry[];
};

type PersistResult =
  | "accepted"
  | "unknown_agent"
  | "rate_limited"
  | "replayed_request"
  | "invalid_payload";

export class LogReportError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function redactCompressedIpv6Candidates(message: string): string {
  return message.replace(IPV6_CANDIDATE_PATTERN, (candidate) =>
    isIP(candidate) === 6 ? "[REDACTED_IP]" : candidate,
  );
}

export function redactConsoleLogMessage(message: string): string {
  return redactCompressedIpv6Candidates(
    message
      .replace(ANSI_PATTERN, "")
      .replace(MINECRAFT_FORMAT_PATTERN, "")
      .replace(CONTROL_PATTERN, " ")
      .replace(BEARER_PATTERN, "Bearer [REDACTED]")
      .replace(SECRET_QUERY_PATTERN, "$1[REDACTED]")
      .replace(SECRET_QUOTED_ASSIGNMENT_PATTERN, "$1$2$3$4[REDACTED]$4")
      .replace(SECRET_ASSIGNMENT_PATTERN, "$1$2$3[REDACTED]")
      .replace(IPV4_PATTERN, "[REDACTED_IP]")
      .replace(IPV6_PATTERN, "[REDACTED_IP]"),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_CHARACTERS);
}

function eventIdFor(entry: Omit<LogReportEntry, "eventId">): string {
  return createHash("sha256")
    .update(entry.sourceType)
    .update("\0")
    .update(entry.sourceName)
    .update("\0")
    .update(entry.observedAt)
    .update("\0")
    .update(entry.message)
    .digest("hex");
}

function normalizeEntry(value: unknown, reportedAt: string): LogReportEntry | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ENTRY_KEYS)) return null;
  if (
    typeof value.sourceType !== "string" ||
    typeof value.sourceName !== "string" ||
    typeof value.observedAt !== "string" ||
    !RFC3339_MICRO_PATTERN.test(value.observedAt) ||
    typeof value.level !== "string" ||
    !isConsoleLogLevel(value.level) ||
    typeof value.message !== "string" ||
    value.message.length < 1 ||
    value.message.length > MAX_RAW_MESSAGE_CHARACTERS
  ) {
    return null;
  }

  const source = getConsoleLogSource(value.sourceName);
  if (!source || source.type !== value.sourceType) return null;

  const observedAtMs = Date.parse(value.observedAt);
  const reportedAtMs = Date.parse(reportedAt);
  if (
    !Number.isFinite(observedAtMs) ||
    observedAtMs < reportedAtMs - MAX_CLOCK_SKEW_SECONDS * 1_000 ||
    observedAtMs > reportedAtMs + MAX_CLOCK_SKEW_SECONDS * 1_000
  ) {
    return null;
  }

  const message = redactConsoleLogMessage(value.message);
  if (!message) return null;

  const normalized = {
    sourceType: source.type,
    sourceName: source.name,
    observedAt: value.observedAt,
    level: value.level,
    message,
  } satisfies Omit<LogReportEntry, "eventId">;

  return { ...normalized, eventId: eventIdFor(normalized) };
}

export function parseLogReport(rawBody: Uint8Array): LogReportPayload {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    throw new LogReportError(400, "invalid_json");
  }

  if (!isRecord(value) || !hasOnlyKeys(value, REPORT_KEYS)) {
    throw new LogReportError(400, "invalid_payload");
  }
  if (
    typeof value.serverId !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(value.serverId) ||
    typeof value.reportedAt !== "string" ||
    !RFC3339_MICRO_PATTERN.test(value.reportedAt) ||
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > MAX_ENTRIES
  ) {
    throw new LogReportError(400, "invalid_payload");
  }

  const serverId = value.serverId;
  const reportedAt = value.reportedAt;
  const rawEntries = value.entries;
  const reportedAtMs = Date.parse(reportedAt);
  if (!Number.isFinite(reportedAtMs) || Math.abs(Date.now() - reportedAtMs) > MAX_CLOCK_SKEW_SECONDS * 1_000) {
    throw new LogReportError(401, "expired_request");
  }

  const entries = rawEntries.map((entry) => normalizeEntry(entry, reportedAt));
  if (entries.some((entry) => entry === null)) {
    throw new LogReportError(400, "invalid_payload");
  }

  const uniqueEntries = new Map<string, LogReportEntry>();
  for (const entry of entries as LogReportEntry[]) {
    uniqueEntries.set(entry.eventId, entry);
  }

  return {
    serverId,
    reportedAt,
    entries: [...uniqueEntries.values()],
  };
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new LogReportError(503, "service_not_configured");
  return value;
}

function readAgentSecrets(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(requireEnvironment("IVRM_AGENT_SECRETS_JSON"));
    if (!isRecord(parsed)) throw new Error("invalid map");
    const secrets: Record<string, string> = {};
    for (const [serverId, secret] of Object.entries(parsed)) {
      if (typeof secret !== "string" || secret.length < 32) throw new Error("invalid secret");
      secrets[serverId] = secret;
    }
    return secrets;
  } catch (error) {
    if (error instanceof LogReportError) throw error;
    throw new LogReportError(503, "service_not_configured");
  }
}

export function authenticateLogReport(
  headers: Headers,
  rawBody: Uint8Array,
  payload: LogReportPayload,
): { nonce: string; bodySha256: string } {
  const serverId = headers.get("x-ivrm-agent-id") ?? "";
  const timestamp = headers.get("x-ivrm-timestamp") ?? "";
  const nonce = headers.get("x-ivrm-nonce") ?? "";
  const signature = headers.get("x-ivrm-signature") ?? "";

  if (serverId !== payload.serverId) throw new LogReportError(401, "agent_id_mismatch");
  if (!/^\d{10}$/.test(timestamp)) throw new LogReportError(401, "invalid_timestamp");
  if (Math.abs(Date.now() / 1_000 - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) {
    throw new LogReportError(401, "expired_request");
  }
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new LogReportError(401, "invalid_nonce");
  if (!/^[a-f0-9]{64}$/.test(signature)) throw new LogReportError(401, "invalid_signature");

  const secret = readAgentSecrets()[serverId];
  if (!secret) throw new LogReportError(401, "unknown_agent");

  const expected = createHmac("sha256", secret)
    .update(timestamp)
    .update(".")
    .update(nonce)
    .update(".")
    .update(rawBody)
    .digest();
  const provided = Buffer.from(signature, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new LogReportError(401, "invalid_signature");
  }

  return {
    nonce,
    bodySha256: createHash("sha256").update(rawBody).digest("hex"),
  };
}

function supabaseConfiguration(): { url: string; serviceRoleKey: string } {
  return {
    url: requireEnvironment("SUPABASE_URL").replace(/\/$/, ""),
    serviceRoleKey: requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

function handlePersistResult(result: PersistResult): void {
  if (result === "accepted") return;
  if (result === "unknown_agent") throw new LogReportError(401, result);
  if (result === "rate_limited") throw new LogReportError(429, result);
  if (result === "replayed_request") throw new LogReportError(409, result);
  throw new LogReportError(400, "invalid_payload");
}

export async function persistLogReport(
  payload: LogReportPayload,
  nonce: string,
  bodySha256: string,
): Promise<void> {
  const { url, serviceRoleKey } = supabaseConfiguration();
  const response = await fetch(`${url}/rest/v1/rpc/ingest_console_log_report_v1`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_server_id: payload.serverId,
      p_reported_at: payload.reportedAt,
      p_request_nonce: nonce,
      p_body_sha256: bodySha256,
      p_entries: payload.entries,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new LogReportError(503, "storage_unavailable");
  const result = (await response.json()) as PersistResult;
  if (![
    "accepted",
    "unknown_agent",
    "rate_limited",
    "replayed_request",
    "invalid_payload",
  ].includes(result)) {
    throw new LogReportError(503, "storage_unavailable");
  }
  handlePersistResult(result);
}
