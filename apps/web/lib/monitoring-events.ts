import type { HistoryRange } from "./history";
import { isValidHostServerId } from "./host-monitoring-events";

export const MONITORING_EVENT_SEVERITIES = [
  "info",
  "warning",
  "critical",
  "recovery",
] as const;

export type MonitoringEventSeverity =
  (typeof MONITORING_EVENT_SEVERITIES)[number];

export type MonitoringEventSeverityFilter =
  | "all"
  | MonitoringEventSeverity;

export type MonitoringEventType =
  | "state_changed"
  | "health_changed"
  | "restart_count_increased"
  | "oom_killed"
  | "exit_code_changed"
  | "maintenance_started"
  | "maintenance_ended";

export type MonitoringEvent = {
  id: number;
  hostId: string;
  serverId: string;
  hostDisplayName: string;
  containerName: string;
  occurredAt: string;
  eventType: MonitoringEventType;
  severity: MonitoringEventSeverity;
  fromValue: string | null;
  toValue: string | null;
  numericValue: number | null;
  expectedState: "running" | "stopped" | "absent" | null;
};

type MonitoringEventRow = {
  event_id: unknown;
  host_id: unknown;
  server_id: unknown;
  host_display_name: unknown;
  container_name: unknown;
  occurred_at: unknown;
  event_type: unknown;
  severity: unknown;
  from_value: unknown;
  to_value: unknown;
  numeric_value: unknown;
  expected_state: unknown;
};

type MonitoringEventQuery = {
  range: HistoryRange;
  serverId?: string | null;
  containerName?: string | null;
  severity?: MonitoringEventSeverity | null;
};

const CONTAINER_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PAGE_SIZE = 500;
const EVENT_TYPES = new Set<MonitoringEventType>([
  "state_changed",
  "health_changed",
  "restart_count_increased",
  "oom_killed",
  "exit_code_changed",
  "maintenance_started",
  "maintenance_ended",
]);
const SEVERITIES = new Set<MonitoringEventSeverity>(MONITORING_EVENT_SEVERITIES);
const EXPECTED_STATES = new Set(["running", "stopped", "absent"] as const);

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

function hostIdentifier(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (!isValidHostServerId(value)) {
    throw new Error("監視イベントのHost識別子が不正です");
  }
  return value;
}

function containerIdentifier(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (!CONTAINER_IDENTIFIER_PATTERN.test(value)) {
    throw new Error("監視イベントのContainer識別子が不正です");
  }
  return value;
}

function stringValue(value: unknown, maximumLength = 128): string | null {
  return typeof value === "string" && value.length <= maximumLength
    ? value
    : null;
}

function integerValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function parseEventRow(row: MonitoringEventRow): MonitoringEvent | null {
  const id = integerValue(row.event_id);
  const hostId = stringValue(row.host_id, 64);
  const serverId = stringValue(row.server_id, 64);
  const hostDisplayName = stringValue(row.host_display_name, 256);
  const containerName = stringValue(row.container_name);
  const occurredAt = timestamp(row.occurred_at);
  const eventType = stringValue(row.event_type) as MonitoringEventType | null;
  const severity = stringValue(row.severity) as MonitoringEventSeverity | null;

  if (
    id === null ||
    id < 0 ||
    !hostId ||
    !serverId ||
    !isValidHostServerId(serverId) ||
    !hostDisplayName ||
    !containerName ||
    !CONTAINER_IDENTIFIER_PATTERN.test(containerName) ||
    !occurredAt ||
    !eventType ||
    !EVENT_TYPES.has(eventType) ||
    !severity ||
    !SEVERITIES.has(severity)
  ) {
    return null;
  }

  const expectedState = stringValue(row.expected_state) as
    | "running"
    | "stopped"
    | "absent"
    | null;

  return {
    id,
    hostId,
    serverId,
    hostDisplayName,
    containerName,
    occurredAt,
    eventType,
    severity,
    fromValue: stringValue(row.from_value),
    toValue: stringValue(row.to_value),
    numericValue: integerValue(row.numeric_value),
    expectedState:
      expectedState && EXPECTED_STATES.has(expectedState)
        ? expectedState
        : null,
  };
}

export function parseMonitoringEventSeverity(
  value: string | null | undefined,
): MonitoringEventSeverityFilter {
  return value && SEVERITIES.has(value as MonitoringEventSeverity)
    ? (value as MonitoringEventSeverity)
    : "all";
}

async function fetchEventPage(
  query: Required<Pick<MonitoringEventQuery, "range">> & {
    serverId: string | null;
    containerName: string | null;
    severity: MonitoringEventSeverity | null;
  },
  beforeAt: string | null,
  beforeId: number | null,
): Promise<MonitoringEvent[]> {
  const { url, serviceRoleKey } = supabaseConfiguration();
  const response = await fetch(`${url}/rest/v1/rpc/get_monitoring_events_v2`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      p_range: query.range,
      p_server_id: query.serverId,
      p_container_name: query.containerName,
      p_severity: query.severity,
      p_before_at: beforeAt,
      p_before_id: beforeId,
      p_limit: PAGE_SIZE,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`get_monitoring_events_v2が${response.status}を返しました`);
  }

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("get_monitoring_events_v2が配列以外を返しました");
  }

  const events = payload.map((row) => parseEventRow(row as MonitoringEventRow));
  if (events.some((event) => event === null)) {
    throw new Error("get_monitoring_events_v2のレスポンス形式が不正です");
  }
  return events as MonitoringEvent[];
}

export async function getMonitoringEvents({
  range,
  serverId,
  containerName,
  severity,
}: MonitoringEventQuery): Promise<MonitoringEvent[]> {
  const safeServerId = hostIdentifier(serverId);
  const safeContainerName = containerIdentifier(containerName);
  if ((safeServerId === null) !== (safeContainerName === null)) {
    throw new Error("HostとContainerは同時に指定してください");
  }
  if (severity && !SEVERITIES.has(severity)) {
    throw new Error("監視イベントのSeverityが不正です");
  }

  const events: MonitoringEvent[] = [];
  let beforeAt: string | null = null;
  let beforeId: number | null = null;

  while (true) {
    const page = await fetchEventPage(
      {
        range,
        serverId: safeServerId,
        containerName: safeContainerName,
        severity: severity ?? null,
      },
      beforeAt,
      beforeId,
    );
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
