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

const SERVER_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const IPV4_LITERAL_PATTERN = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
const PAGE_SIZE = 500;
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

export function isValidHostServerId(value: string): boolean {
  return SERVER_ID_PATTERN.test(value) && !IPV4_LITERAL_PATTERN.test(value);
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
  const serverId = stringValue(row.server_id, 64);
  const hostDisplayName = stringValue(row.host_display_name, 256);
  const occurredAt = timestamp(row.occurred_at);
  const eventType = stringValue(row.event_type) as HostMonitoringEventType | null;
  const severity = stringValue(row.severity) as HostMonitoringEventSeverity | null;

  if (
    id === null ||
    !hostId ||
    !serverId ||
    !isValidHostServerId(serverId) ||
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

async function fetchEventPage(
  range: HistoryRange,
  serverId: string | null,
  beforeAt: string | null,
  beforeId: number | null,
): Promise<HostMonitoringEvent[]> {
  const { url, serviceRoleKey } = supabaseConfiguration();
  const response = await fetch(`${url}/rest/v1/rpc/get_host_monitoring_events_v2`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      p_range: range,
      p_server_id: serverId,
      p_before_at: beforeAt,
      p_before_id: beforeId,
      p_limit: PAGE_SIZE,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`get_host_monitoring_events_v2が${response.status}を返しました`);
  }

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("get_host_monitoring_events_v2が配列以外を返しました");
  }

  const events = payload.map((row) => parseRow(row as HostMonitoringEventRow));
  if (events.some((event) => event === null)) {
    throw new Error("get_host_monitoring_events_v2のレスポンス形式が不正です");
  }
  return events as HostMonitoringEvent[];
}

export async function getHostMonitoringEvents(
  range: HistoryRange,
  serverId?: string | null,
): Promise<HostMonitoringEvent[]> {
  const safeServerId = serverId?.trim() || null;
  if (safeServerId && !isValidHostServerId(safeServerId)) {
    throw new Error("Host識別子が不正です");
  }

  const events: HostMonitoringEvent[] = [];
  let beforeAt: string | null = null;
  let beforeId: number | null = null;

  while (true) {
    const page = await fetchEventPage(range, safeServerId, beforeAt, beforeId);
    events.push(...page);
    if (page.length < PAGE_SIZE) {
      break;
    }

    const last = page.at(-1);
    if (!last) {
      break;
    }
    beforeAt = last.occurredAt;
    beforeId = last.id;
  }

  return events;
}
