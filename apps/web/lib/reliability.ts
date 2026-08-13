import "server-only";

import { getUnifiedIncidentCenterSnapshot } from "./unified-incidents";
import { getNotificationCenterSnapshot } from "./notifications";
import { buildIncidentService } from "./reliability-incident-service";
import { buildNotificationService } from "./reliability-notification-service";
import { buildOverall } from "./reliability-overall-data";
import type { ReliabilityRange, ReliabilitySnapshot } from "./reliability-types";

export type {
  ReliabilityHealth,
  ReliabilityRange,
  ReliabilityService,
  ReliabilityServiceId,
  ReliabilitySnapshot,
} from "./reliability-types";

export async function getReliabilitySnapshot(
  range: ReliabilityRange,
): Promise<ReliabilitySnapshot> {
  const notificationPromise = getNotificationCenterSnapshot()
    .then((snapshot) => ({ ok: true as const, snapshot }))
    .catch((error: unknown) => {
      console.error("Reliability CenterのNotification情報取得に失敗しました", error);
      return { ok: false as const, snapshot: null };
    });
  const [incidents, notification] = await Promise.all([
    getUnifiedIncidentCenterSnapshot(range),
    notificationPromise,
  ]);
  const set = (type: "host" | "container" | "backup") => ({
    active: incidents.active.filter((item) => item.entityType === type),
    recovered: incidents.recovered.filter((item) => item.entityType === type),
  });
  const services = [
    buildIncidentService("host", set("host"), range, incidents.generatedAt),
    buildIncidentService("container", set("container"), range, incidents.generatedAt),
    buildIncidentService(
      "backup",
      set("backup"),
      range,
      incidents.generatedAt,
      incidents.backupDataAvailable,
    ),
    buildNotificationService(notification.snapshot),
  ];

  return {
    generatedAt: incidents.generatedAt,
    range,
    backupDataAvailable: incidents.backupDataAvailable,
    notificationDataAvailable: notification.ok,
    overall: buildOverall(incidents, services, range),
    services,
    notifications: {
      enabled: notification.snapshot?.summary.channelEnabled ?? null,
      configured: notification.snapshot?.summary.channelConfigured ?? null,
      pendingCount: notification.snapshot?.summary.pendingCount ?? null,
      retryCount: notification.snapshot?.summary.retryCount ?? null,
      failedCount: notification.snapshot?.summary.failedCount ?? null,
      suppressedCount: notification.snapshot?.summary.suppressedCount ?? null,
      sent24hCount: notification.snapshot?.summary.sent24hCount ?? null,
      activeSuppressionCount: notification.snapshot?.summary.activeSuppressionCount ?? null,
      lastDeliveryAt: notification.snapshot?.summary.lastDeliveryAt ?? null,
      dispatcherLastSuccessAt: notification.snapshot?.summary.dispatcherLastSuccessAt ?? null,
      lastErrorCode:
        notification.snapshot?.summary.dispatcherLastErrorCode ??
        notification.snapshot?.summary.channelLastErrorCode ??
        null,
    },
  };
}
