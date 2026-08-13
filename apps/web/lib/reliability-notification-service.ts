import type { NotificationCenterSnapshot } from "./notifications";
import type { ReliabilityHealth, ReliabilityService } from "./reliability-types";

export function notificationHealth(snapshot: NotificationCenterSnapshot | null): ReliabilityHealth {
  if (!snapshot) return "unknown";
  const summary = snapshot.summary;
  if (!summary.channelEnabled) return "disabled";
  if (!summary.channelConfigured || summary.channelLastErrorCode || summary.dispatcherLastErrorCode) {
    return "critical";
  }
  if (summary.pendingCount > 0 || summary.retryCount > 0 || summary.failedCount > 0) {
    return "degraded";
  }
  return "operational";
}

export function buildNotificationService(snapshot: NotificationCenterSnapshot | null): ReliabilityService {
  const summary = snapshot?.summary;
  return {
    id: "notifications",
    label: "Notification Delivery",
    description: "Discord Channel・Dispatcher・Durable Outboxの配送品質",
    health: notificationHealth(snapshot),
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
