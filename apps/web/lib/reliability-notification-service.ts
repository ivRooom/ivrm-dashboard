import type { NotificationSummary } from "./notifications";
import type { ReliabilityHealth, ReliabilityService } from "./reliability-types";

const DISPATCHER_STALE_AFTER_MS = 180_000;

export function notificationHealth(summary: NotificationSummary | null): ReliabilityHealth {
  if (!summary) return "unknown";
  if (!summary.channelEnabled) return "disabled";
  if (!summary.channelConfigured || summary.channelLastErrorCode || summary.dispatcherLastErrorCode) {
    return "critical";
  }
  const generatedAt = Date.parse(summary.generatedAt);
  const invokedAt = summary.dispatcherLastInvokedAt
    ? Date.parse(summary.dispatcherLastInvokedAt)
    : Number.NaN;
  if (
    !Number.isFinite(generatedAt) ||
    !Number.isFinite(invokedAt) ||
    generatedAt - invokedAt > DISPATCHER_STALE_AFTER_MS
  ) {
    return "critical";
  }
  if (summary.pendingCount > 0 || summary.retryCount > 0 || summary.failedCount > 0) {
    return "degraded";
  }
  return "operational";
}

export function buildNotificationService(summary: NotificationSummary | null): ReliabilityService {
  return {
    id: "notifications",
    label: "Notification Delivery",
    description: "Discord Channel・Dispatcher・Durable Outboxの配送品質",
    health: notificationHealth(summary),
    activeIncidentCount: summary ? summary.pendingCount + summary.retryCount + summary.failedCount : 0,
    activeCriticalCount: summary?.failedCount ?? 0,
    activeWarningCount: summary ? summary.pendingCount + summary.retryCount : 0,
    recoveredIncidentCount: summary?.sent24hCount ?? 0,
    knownDowntimeSeconds: null,
    incidentFreeRatio: null,
    exactCoverage: false,
    medianRecoverySeconds: null,
    longestRecoverySeconds: null,
    latestRecoveredAt: summary?.lastDeliveryAt ?? null,
    affectedEntityCount: summary?.activeSignalCount ?? 0,
    detailHref: "/notifications",
  };
}

export function overallHealth(services: ReliabilityService[]): ReliabilityHealth {
  const enabled = services.filter((service) => service.health !== "disabled");
  if (enabled.some((service) => service.health === "critical")) return "critical";
  if (enabled.some((service) => service.health === "degraded")) return "degraded";
  if (enabled.some((service) => service.health === "unknown")) return "unknown";
  return "operational";
}
