import "server-only";

import type { NotificationSummary } from "./notifications";

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}が設定されていません`);
  return value;
}

function integer(value: unknown): number | null {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^\d+$/.test(value))
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function nullableTimestamp(value: unknown): string | null | undefined {
  return value === null ? null : timestamp(value) ?? undefined;
}

function nullableText(value: unknown): string | null | undefined {
  return value === null
    ? null
    : typeof value === "string" && value.length > 0 && value.length <= 128
      ? value
      : undefined;
}

export async function getNotificationSummary(): Promise<NotificationSummary> {
  const base = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${base}/rest/v1/rpc/get_notification_center_summary_v1`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: "{}",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`get_notification_center_summary_v1が${response.status}を返しました`);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload) || payload.length !== 1 || typeof payload[0] !== "object" || payload[0] === null) {
    throw new Error("Notification Summaryレスポンスが不正です");
  }
  const row = payload[0] as Record<string, unknown>;
  const counts = [
    row.active_signal_count, row.active_critical_count, row.active_warning_count,
    row.pending_count, row.retry_count, row.failed_count, row.suppressed_count,
    row.sent_24h_count, row.active_suppression_count,
  ].map(integer);
  const generatedAt = timestamp(row.generated_at);
  const lastDeliveryAt = nullableTimestamp(row.last_delivery_at);
  const channelLastErrorAt = nullableTimestamp(row.channel_last_error_at);
  const channelLastErrorCode = nullableText(row.channel_last_error_code);
  const dispatcherLastInvokedAt = nullableTimestamp(row.dispatcher_last_invoked_at);
  const dispatcherLastSuccessAt = nullableTimestamp(row.dispatcher_last_success_at);
  const dispatcherLastErrorAt = nullableTimestamp(row.dispatcher_last_error_at);
  const dispatcherLastErrorCode = nullableText(row.dispatcher_last_error_code);
  if (
    !generatedAt || typeof row.channel_enabled !== "boolean" || typeof row.channel_configured !== "boolean" ||
    typeof row.channel_display_name !== "string" || row.channel_display_name.length === 0 || counts.some((value) => value === null) ||
    lastDeliveryAt === undefined || channelLastErrorAt === undefined || channelLastErrorCode === undefined ||
    dispatcherLastInvokedAt === undefined || dispatcherLastSuccessAt === undefined || dispatcherLastErrorAt === undefined || dispatcherLastErrorCode === undefined
  ) throw new Error("Notification Summaryレスポンス形式が不正です");

  return {
    generatedAt,
    channelEnabled: row.channel_enabled,
    channelConfigured: row.channel_configured,
    channelDisplayName: row.channel_display_name,
    activeSignalCount: counts[0] as number,
    activeCriticalCount: counts[1] as number,
    activeWarningCount: counts[2] as number,
    pendingCount: counts[3] as number,
    retryCount: counts[4] as number,
    failedCount: counts[5] as number,
    suppressedCount: counts[6] as number,
    sent24hCount: counts[7] as number,
    activeSuppressionCount: counts[8] as number,
    lastDeliveryAt,
    channelLastErrorAt,
    channelLastErrorCode,
    dispatcherLastInvokedAt,
    dispatcherLastSuccessAt,
    dispatcherLastErrorAt,
    dispatcherLastErrorCode,
  };
}
