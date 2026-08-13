import type { HistoryRange } from "./history";

export type HostMonitoringEventType =
  | "host_reboot_detected"
  | "agent_version_changed"
  | "heartbeat_gap_detected";

export type HostMonitoringEventSeverity = "info" | "warning";

export type HostMonitoringEvent = {
  id: number;
  hostId: string;
  serverId: string;
  hostDisplayName: string;
  occurredAt: string;
  eventType: HostMonitoringEventType;
  severity: HostMonitoringEventSeverity;
  fromValue: string | null;
  toValue: string | null;
  numericValue: number | null;
};

type HostMonitoringEventRow = {
  event_id: unknown;
  host_id: unknown;
  server_id: unknown;
  host_display_name: unknown;
  occurred_at: unknown;
  event_type: unknown;
  severity: unknown;
  from_value: unknown;
  to_value: unknown;
  numeric_value: unknown;
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const EVENT_TYPES = new Set<HostMonitoringEventType>([
  "host_reboot_detected",
  "agent_version_changed",
  "heartbeat_gap_detected",
]);
const SEVERITIES = new Set<HostMonitoringEventSeverity>(["info", "warning"]);

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name}が設定されていません`);
  }
  return value;
}

function supabaseConfiguration(): { url: string; serviceRoleKey: string } {
  return {
    url: requireEnvironment("SUPABASE_URL").replace(/\/$/, ""),
    serviceRoleKey: requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

function stringValue(value: unknown, maximumLength = 128): string | null {
  return typeof value === "string" && value.length <= maximumLength
    ? value
    : null;
}

function safeInteger(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function parseRow(row: HostMonitoringEventRow): HostMonitoringEvent | null {
  const id = safeInteger(row.event_id);
  const hostId = stringValue(row.host_id, 64);
  const serverId = stringValue(row.server_id);
  const hostDisplayName = stringValue(row.host_display_name, 256);
  const occurredAt = timestamp(row.occurred_at);
  const eventType = stringValue(row.event_type) as HostMonitoringEventType | null;
  const severity = stringValue(row.severity) as HostMonitoringEventSeverity | null;

  if (
    id === null ||
    !hostId ||
    !serverId ||
    !hostDisplayName ||
    !occurredAt ||
    !eventType ||
    !EVENT_TYPES.has(eventType) ||
    !severity ||
    !SEVERITIES.has(severity)
  ) {
    return null;
  }

  return {
    id,
    hostId,
    serverId,
    hostDisplayName,
    occurredAt,
    eventType,
    severity,
    fromValue: stringValue(row.from_value),
    toValue: stringValue(row.to_value),
    numericValue: safeInteger(row.numeric_value),
  };
}

export async function getHostMonitoringEvents(
  range: HistoryRange,
  serverId?: string | null,
): Promise<HostMonitoringEvent[]> {
  const safeServerId = serverId?.trim() || null;
  if (safeServerId && !IDENTIFIER_PATTERN.test(safeServerId)) {
    throw new Error("Host識別子が不正です");
  }

  const { url, serviceRoleKey } = supabaseConfiguration();
  const response = await fetch(`${url}/rest/v1/rpc/get_host_monitoring_events_v1`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      p_range: range,
      p_server_id: safeServerId,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`get_host_monitoring_events_v1が${response.status}を返しました`);
  }

  const rows = (await response.json()) as HostMonitoringEventRow[];
  return rows
    .map(parseRow)
    .filter((event): event is HostMonitoringEvent => event !== null)
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));
}
