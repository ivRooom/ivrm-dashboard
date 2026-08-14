import "server-only";

import { getUnifiedIncidentCenterSnapshot } from "./unified-incidents";
import { getNotificationSummary } from "./notification-summary";
import { buildIncidentService } from "./reliability-incident-service";
import { buildNotificationService } from "./reliability-notification-service";
import { buildOverall } from "./reliability-overall-data";
import {
  buildReliabilitySloBudgets,
  getReliabilitySloPolicies,
} from "./reliability-slo";
import type { ReliabilityRange, ReliabilitySnapshot } from "./reliability-types";

export type {
  ReliabilityHealth,
  ReliabilityRange,
  ReliabilityService,
  ReliabilityServiceId,
  ReliabilitySloBudget,
  ReliabilitySloBudgetState,
  ReliabilitySloPolicy,
  ReliabilitySloServiceId,
  ReliabilitySnapshot,
} from "./reliability-types";

export async function getReliabilitySnapshot(
  range: ReliabilityRange,
): Promise<ReliabilitySnapshot> {
  const notificationPromise = getNotificationSummary()
    .then((summary) => ({ ok: true as const, summary }))
    .catch((error: unknown) => {
      console.error("Reliability CenterのNotification Summary取得に失敗しました", error);
      return { ok: false as const, summary: null };
    });
  const sloPolicyPromise = getReliabilitySloPolicies()
    .then((policies) => ({ ok: true as const, policies }))
    .catch((error: unknown) => {
      console.error("Reliability CenterのSLO Policy取得に失敗しました", error);
      return { ok: false as const, policies: null };
    });
  const [incidents, notification, sloPolicy] = await Promise.all([
    getUnifiedIncidentCenterSnapshot(range),
    notificationPromise,
    sloPolicyPromise,
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
    buildNotificationService(notification.summary),
  ];
  const overall = buildOverall(incidents, services, range);

  return {
    generatedAt: incidents.generatedAt,
    range,
    backupDataAvailable: incidents.backupDataAvailable,
    notificationDataAvailable: notification.ok,
    sloPolicyDataAvailable: sloPolicy.ok,
    overall,
    services,
    sloBudgets: buildReliabilitySloBudgets(
      services,
      overall,
      sloPolicy.policies,
      range,
    ),
    notifications: {
      enabled: notification.summary?.channelEnabled ?? null,
      configured: notification.summary?.channelConfigured ?? null,
      pendingCount: notification.summary?.pendingCount ?? null,
      retryCount: notification.summary?.retryCount ?? null,
      failedCount: notification.summary?.failedCount ?? null,
      suppressedCount: notification.summary?.suppressedCount ?? null,
      sent24hCount: notification.summary?.sent24hCount ?? null,
      activeSuppressionCount: notification.summary?.activeSuppressionCount ?? null,
      lastDeliveryAt: notification.summary?.lastDeliveryAt ?? null,
      dispatcherLastSuccessAt: notification.summary?.dispatcherLastSuccessAt ?? null,
      lastErrorCode:
        notification.summary?.dispatcherLastErrorCode ??
        notification.summary?.channelLastErrorCode ??
        null,
    },
  };
}
