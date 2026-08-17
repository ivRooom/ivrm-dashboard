import {
  CONSOLE_LOG_RANGES,
  isConsoleLogLevel,
  isConsoleLogSourceName,
  type ConsoleLogLevel,
  type ConsoleLogSourceName,
} from "./console-log-types";

export type ConsoleLogEntry = {
  id: number;
  serverId: string;
  hostDisplayName: string;
  sourceType: "container" | "systemd";
  sourceName: ConsoleLogSourceName;
  observedAt: string;
  level: ConsoleLogLevel;
  message: string;
  receivedAt: string;
};

export type ConsoleLogQuery = {
  serverId: string;
  sourceName?: ConsoleLogSourceName | null;
  level?: ConsoleLogLevel | null;
  query?: string | null;
  windowMinutes?: number;
  afterId?: number | null;
  limit?: number;
};

type NormalizedConsoleLogQuery = {
  serverId: string;
  sourceName: ConsoleLogSourceName | null;
  level: ConsoleLogLevel | null;
  query: string | null;
  windowMinutes: number;
  afterId: number | null;
  limit: number;
};

type RpcLogRow = {
  row_id: unknown;
  server_id: unknown;
  host_display_name: unknown;
  source_type: unknown;
  source_name: unknown;
  observed_at: unknown;
  level: unknown;
  message: unknown;
  received_at: unknown;
};

export class ConsoleLogsError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConsoleLogsError("service_not_configured");
  return value;
}

function normalizeQuery(input: ConsoleLogQuery): NormalizedConsoleLogQuery {
  const query = input.query?.trim() || null;
  const limit = input.limit ?? 300;
  const windowMinutes = input.windowMinutes ?? 1440;
  const validWindow = CONSOLE_LOG_RANGES.some((range) => range.minutes === windowMinutes);
  if (
    !/^[A-Za-z0-9._-]{1,64}$/.test(input.serverId) ||
    (input.sourceName != null && !isConsoleLogSourceName(input.sourceName)) ||
    (input.level != null && !isConsoleLogLevel(input.level)) ||
    (query !== null && query.length > 80) ||
    !validWindow ||
    (input.afterId != null && (!Number.isSafeInteger(input.afterId) || input.afterId < 0)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500
  ) {
    throw new ConsoleLogsError("invalid_query");
  }

  return {
    serverId: input.serverId,
    sourceName: input.sourceName ?? null,
    level: input.level ?? null,
    query,
    windowMinutes,
    afterId: input.afterId ?? null,
    limit,
  };
}

function parseTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function parseRow(value: unknown): ConsoleLogEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as RpcLogRow;
  const id = typeof row.row_id === "number" ? row.row_id : Number(row.row_id);
  const observedAt = parseTimestamp(row.observed_at);
  const receivedAt = parseTimestamp(row.received_at);
  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof row.server_id !== "string" ||
    typeof row.host_display_name !== "string" ||
    (row.source_type !== "container" && row.source_type !== "systemd") ||
    typeof row.source_name !== "string" ||
    !isConsoleLogSourceName(row.source_name) ||
    typeof row.level !== "string" ||
    !isConsoleLogLevel(row.level) ||
    typeof row.message !== "string" ||
    row.message.length < 1 ||
    row.message.length > 2048 ||
    !observedAt ||
    !receivedAt
  ) {
    return null;
  }

  return {
    id,
    serverId: row.server_id,
    hostDisplayName: row.host_display_name,
    sourceType: row.source_type,
    sourceName: row.source_name,
    observedAt,
    level: row.level,
    message: row.message,
    receivedAt,
  };
}

export async function getConsoleLogs(input: ConsoleLogQuery): Promise<ConsoleLogEntry[]> {
  const query = normalizeQuery(input);
  const url = requireEnvironment("SUPABASE_URL").replace(/\/$/, "");
  const serviceRoleKey = requireEnvironment("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${url}/rest/v1/rpc/get_console_logs_v2`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_server_id: query.serverId,
      p_source_name: query.sourceName,
      p_level: query.level,
      p_query: query.query,
      p_window_minutes: query.windowMinutes,
      p_after_id: query.afterId,
      p_limit: query.limit,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) throw new ConsoleLogsError("storage_unavailable");

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new ConsoleLogsError("invalid_storage_response");
  const entries = payload.map(parseRow);
  if (entries.some((entry) => entry === null)) {
    throw new ConsoleLogsError("invalid_storage_response");
  }
  return entries as ConsoleLogEntry[];
}
