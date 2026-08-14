import "server-only";

export type NotificationSeverity = "info" | "warning" | "critical" | "recovery";
export type NotificationSource = "host" | "container" | "backup" | "reliability";
export type NotificationStatus = "pending" | "sending" | "sent" | "retry" | "failed" | "suppressed";
export type NotificationTransition = "opened" | "escalated" | "recovered" | "event";

export type NotificationSummary = {
  generatedAt: string;
  channelEnabled: boolean;
  channelConfigured: boolean;
  channelDisplayName: string;
  activeSignalCount: number;
  activeCriticalCount: number;
  activeWarningCount: number;
  pendingCount: number;
  retryCount: number;
  failedCount: number;
  suppressedCount: number;
  sent24hCount: number;
  activeSuppressionCount: number;
  lastDeliveryAt: string | null;
  channelLastErrorAt: string | null;
  channelLastErrorCode: string | null;
  dispatcherLastInvokedAt: string | null;
  dispatcherLastSuccessAt: string | null;
  dispatcherLastErrorAt: string | null;
  dispatcherLastErrorCode: string | null;
};

export type NotificationSignal = {
  signalKey: string;
  sourceType: NotificationSource;
  serverId: string;
  entityType: NotificationSource;
  entityName: string;
  signalType: string;
  severity: "warning" | "critical";
  openedAt: string;
  lastSeenAt: string;
  reason: string;
  detailHref: string;
};

export type NotificationDelivery = {
  rowId: number;
  sourceType: NotificationSource;
  serverId: string;
  entityType: NotificationSource;
  entityName: string;
  transition: NotificationTransition;
  severity: NotificationSeverity;
  title: string;
  message: string;
  detailHref: string;
  occurredAt: string;
  status: NotificationStatus;
  suppressionReason: string | null;
  attempts: number;
  sentAt: string | null;
  lastHttpStatus: number | null;
  lastErrorCode: string | null;
};

export type NotificationSuppression = {
  rowId: number;
  scopeType: "global" | "host" | "container" | "backup" | "reliability" | "signal";
  scopeKey: string;
  reason: string;
  startsAt: string;
  endsAt: string | null;
};

export type NotificationCenterSnapshot = {
  summary: NotificationSummary;
  signals: NotificationSignal[];
  deliveries: NotificationDelivery[];
  suppressions: NotificationSuppression[];
};

type Row = Record<string, unknown>;
const SOURCES = new Set<NotificationSource>(["host", "container", "backup", "reliability"]);
const SEVERITIES = new Set<NotificationSeverity>(["info", "warning", "critical", "recovery"]);
const STATUSES = new Set<NotificationStatus>(["pending", "sending", "sent", "retry", "failed", "suppressed"]);
const TRANSITIONS = new Set<NotificationTransition>(["opened", "escalated", "recovered", "event"]);
const SUPPRESSION_SCOPES = new Set(["global", "host", "container", "backup", "reliability", "signal"] as const);

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}が設定されていません`);
  return value;
}

async function callRpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const url = requireEnvironment("SUPABASE_URL").replace(/\/$/, "");
  const serviceRoleKey = requireEnvironment("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${name}が${response.status}を返しました`);
  return response.json();
}

function objectRow(value: unknown): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Notification Centerレスポンス形式が不正です");
  }
  return value as Row;
}

function text(value: unknown, maximum = 2000): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function nullableTimestamp(value: unknown): string | null | undefined {
  return value === null ? null : timestamp(value) ?? undefined;
}

function nullableText(value: unknown, maximum = 256): string | null | undefined {
  return value === null ? null : text(value, maximum) ?? undefined;
}

function nullableInteger(value: unknown): number | null | undefined {
  return value === null ? null : integer(value) ?? undefined;
}

function validRelativeHref(value: unknown): string | null {
  const href = text(value, 1001);
  return href && href.startsWith("/") && !href.startsWith("//") ? href : null;
}

function singleRow(payload: unknown): Row {
  if (!Array.isArray(payload) || payload.length !== 1) throw new Error("Notification Summaryレスポンスが不正です");
  return objectRow(payload[0]);
}

function parseSummary(payload: unknown): NotificationSummary {
  const row = singleRow(payload);
  const generatedAt = timestamp(row.generated_at);
  const channelEnabled = bool(row.channel_enabled);
  const channelConfigured = bool(row.channel_configured);
  const channelDisplayName = text(row.channel_display_name, 80);
  const counts = [
    row.active_signal_count, row.active_critical_count, row.active_warning_count,
    row.pending_count, row.retry_count, row.failed_count, row.suppressed_count,
    row.sent_24h_count, row.active_suppression_count,
  ].map(integer);
  const lastDeliveryAt = nullableTimestamp(row.last_delivery_at);
  const channelLastErrorAt = nullableTimestamp(row.channel_last_error_at);
  const channelLastErrorCode = nullableText(row.channel_last_error_code, 128);
  const dispatcherLastInvokedAt = nullableTimestamp(row.dispatcher_last_invoked_at);
  const dispatcherLastSuccessAt = nullableTimestamp(row.dispatcher_last_success_at);
  const dispatcherLastErrorAt = nullableTimestamp(row.dispatcher_last_error_at);
  const dispatcherLastErrorCode = nullableText(row.dispatcher_last_error_code, 128);
  if (!generatedAt || channelEnabled === null || channelConfigured === null || !channelDisplayName || counts.some((count) => count === null) ||
      lastDeliveryAt === undefined || channelLastErrorAt === undefined || channelLastErrorCode === undefined ||
      dispatcherLastInvokedAt === undefined || dispatcherLastSuccessAt === undefined || dispatcherLastErrorAt === undefined || dispatcherLastErrorCode === undefined) {
    throw new Error("Notification Summaryレスポンス形式が不正です");
  }
  return {
    generatedAt, channelEnabled, channelConfigured, channelDisplayName,
    activeSignalCount: counts[0] as number, activeCriticalCount: counts[1] as number, activeWarningCount: counts[2] as number,
    pendingCount: counts[3] as number, retryCount: counts[4] as number, failedCount: counts[5] as number,
    suppressedCount: counts[6] as number, sent24hCount: counts[7] as number, activeSuppressionCount: counts[8] as number,
    lastDeliveryAt, channelLastErrorAt, channelLastErrorCode,
    dispatcherLastInvokedAt, dispatcherLastSuccessAt, dispatcherLastErrorAt, dispatcherLastErrorCode,
  };
}

function parseSignals(payload: unknown): NotificationSignal[] {
  if (!Array.isArray(payload)) throw new Error("Notification Signalレスポンスが不正です");
  return payload.map((value) => {
    const row = objectRow(value);
    const signalKey = text(row.signal_key, 500);
    const sourceType = text(row.source_type) as NotificationSource | null;
    const serverId = text(row.server_id, 128);
    const entityType = text(row.entity_type) as NotificationSource | null;
    const entityName = text(row.entity_name, 256);
    const signalType = text(row.signal_type, 80);
    const severity = text(row.severity) as "warning" | "critical" | null;
    const openedAt = timestamp(row.opened_at);
    const lastSeenAt = timestamp(row.last_seen_at);
    const reason = text(row.reason, 1800);
    const detailHref = validRelativeHref(row.detail_href);
    if (!signalKey || !sourceType || !SOURCES.has(sourceType) || !serverId || !entityType || !SOURCES.has(entityType) || !entityName ||
        !signalType || !severity || !["warning", "critical"].includes(severity) || !openedAt || !lastSeenAt || !reason || !detailHref) {
      throw new Error("Notification Signal行が不正です");
    }
    return { signalKey, sourceType, serverId, entityType, entityName, signalType, severity, openedAt, lastSeenAt, reason, detailHref };
  });
}

function parseDeliveries(payload: unknown): NotificationDelivery[] {
  if (!Array.isArray(payload)) throw new Error("Notification Deliveryレスポンスが不正です");
  return payload.map((value) => {
    const row = objectRow(value);
    const rowId = integer(row.row_id);
    const sourceType = text(row.source_type) as NotificationSource | null;
    const serverId = text(row.server_id, 128);
    const entityType = text(row.entity_type) as NotificationSource | null;
    const entityName = text(row.entity_name, 256);
    const transition = text(row.transition) as NotificationTransition | null;
    const severity = text(row.severity) as NotificationSeverity | null;
    const title = text(row.title, 160);
    const message = text(row.message, 1800);
    const detailHref = validRelativeHref(row.detail_href);
    const occurredAt = timestamp(row.occurred_at);
    const status = text(row.status) as NotificationStatus | null;
    const suppressionReason = nullableText(row.suppression_reason, 256);
    const attempts = integer(row.attempts);
    const sentAt = nullableTimestamp(row.sent_at);
    const lastHttpStatus = nullableInteger(row.last_http_status);
    const lastErrorCode = nullableText(row.last_error_code, 128);
    if (rowId === null || rowId < 1 || !sourceType || !SOURCES.has(sourceType) || !serverId || !entityType || !SOURCES.has(entityType) ||
        !entityName || !transition || !TRANSITIONS.has(transition) || !severity || !SEVERITIES.has(severity) || !title || !message ||
        !detailHref || !occurredAt || !status || !STATUSES.has(status) || suppressionReason === undefined || attempts === null ||
        sentAt === undefined || lastHttpStatus === undefined || lastErrorCode === undefined) {
      throw new Error("Notification Delivery行が不正です");
    }
    return { rowId, sourceType, serverId, entityType, entityName, transition, severity, title, message, detailHref, occurredAt, status, suppressionReason, attempts, sentAt, lastHttpStatus, lastErrorCode };
  });
}

function parseSuppressions(payload: unknown): NotificationSuppression[] {
  if (!Array.isArray(payload)) throw new Error("Notification Suppressionレスポンスが不正です");
  return payload.map((value) => {
    const row = objectRow(value);
    const rowId = integer(row.row_id);
    const scopeType = text(row.scope_type) as NotificationSuppression["scopeType"] | null;
    const scopeKey = text(row.scope_key, 400);
    const reason = text(row.reason, 256);
    const startsAt = timestamp(row.starts_at);
    const endsAt = nullableTimestamp(row.ends_at);
    if (rowId === null || rowId < 1 || !scopeType || !SUPPRESSION_SCOPES.has(scopeType) || !scopeKey || !reason || !startsAt || endsAt === undefined) {
      throw new Error("Notification Suppression行が不正です");
    }
    return { rowId, scopeType, scopeKey, reason, startsAt, endsAt };
  });
}

export async function getNotificationCenterSnapshot(): Promise<NotificationCenterSnapshot> {
  const [summaryPayload, signalsPayload, deliveriesPayload, suppressionsPayload] = await Promise.all([
    callRpc("get_notification_center_summary_v1", {}),
    callRpc("get_notification_active_signals_v1", { p_limit: 100 }),
    callRpc("get_notification_deliveries_v1", { p_limit: 100, p_before_occurred_at: null, p_before_id: null }),
    callRpc("get_notification_suppressions_v1", {}),
  ]);
  return {
    summary: parseSummary(summaryPayload),
    signals: parseSignals(signalsPayload),
    deliveries: parseDeliveries(deliveriesPayload),
    suppressions: parseSuppressions(suppressionsPayload),
  };
}
