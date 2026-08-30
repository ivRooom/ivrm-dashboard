import "server-only";

import {
  getMinecraftOverview,
  type MinecraftOverallStatus,
  type MinecraftOverview,
} from "./minecraft";
import {
  getMonitoringSnapshot,
  type MonitoringSnapshot,
} from "./monitoring";
import { getNotificationSummary } from "./notification-summary";
import type { NotificationSummary } from "./notifications";
import { buildIncidentService } from "./reliability-incident-service";
import {
  buildNotificationService,
  overallHealth,
} from "./reliability-notification-service";
import type {
  ReliabilityHealth,
  ReliabilityService,
} from "./reliability-types";
import {
  getUnifiedIncidentCenterSnapshot,
  type ActiveIncident,
  type RecoveredIncident,
  type UnifiedIncidentCenterSnapshot,
} from "./unified-incidents";

export type OverviewActivityTone = "neutral" | "success" | "warning" | "danger" | "info";

export type OverviewActivity = {
  id: string;
  occurredAt: string;
  title: string;
  detail: string;
  href: string;
  tone: OverviewActivityTone;
};

export type OverviewSnapshot = {
  generatedAt: string;
  monitoring: MonitoringSnapshot | null;
  minecraft: MinecraftOverview | null;
  incidents: UnifiedIncidentCenterSnapshot | null;
  notification: NotificationSummary | null;
  sources: {
    monitoring: boolean;
    minecraft: boolean;
    incidents: boolean;
    backup: boolean;
    notifications: boolean;
  };
  status: {
    minecraft: MinecraftOverallStatus;
    infrastructure: ReliabilityHealth;
    backup: ReliabilityHealth;
    notifications: ReliabilityHealth;
    reliability: ReliabilityHealth;
  };
  attention: {
    activeCritical: number | null;
    activeWarning: number | null;
    failedNotifications: number | null;
    backupCritical: number | null;
    staleOrOffline: number | null;
  };
  activities: OverviewActivity[];
};

function unavailableIncidentService(id: "host" | "container" | "backup"): ReliabilityService {
  return {
    id,
    label: id,
    description: "",
    health: "unknown",
    activeIncidentCount: 0,
    activeCriticalCount: 0,
    activeWarningCount: 0,
    recoveredIncidentCount: 0,
    knownDowntimeSeconds: null,
    incidentFreeRatio: null,
    exactCoverage: false,
    medianRecoverySeconds: null,
    longestRecoverySeconds: null,
    latestRecoveredAt: null,
    affectedEntityCount: 0,
    detailHref:
      id === "host"
        ? "/hosts"
        : id === "container"
          ? "/containers"
          : "/backups?range=24h",
  };
}

function incidentServices(
  incidents: UnifiedIncidentCenterSnapshot | null,
): [ReliabilityService, ReliabilityService, ReliabilityService] {
  if (!incidents) {
    return [
      unavailableIncidentService("host"),
      unavailableIncidentService("container"),
      unavailableIncidentService("backup"),
    ];
  }

  const set = (type: "host" | "container" | "backup") => ({
    active: incidents.active.filter((item) => item.entityType === type),
    recovered: incidents.recovered.filter((item) => item.entityType === type),
  });

  return [
    buildIncidentService("host", set("host"), "24h", incidents.generatedAt),
    buildIncidentService("container", set("container"), "24h", incidents.generatedAt),
    buildIncidentService(
      "backup",
      set("backup"),
      "24h",
      incidents.generatedAt,
      incidents.backupDataAvailable,
    ),
  ];
}

function infrastructureHealth(monitoring: MonitoringSnapshot | null): ReliabilityHealth {
  if (!monitoring || monitoring.hosts.length === 0) return "unknown";
  if (
    monitoring.hosts.some((host) => host.status === "offline") ||
    monitoring.containers.some(
      (container) => container.status === "offline" || container.status === "error",
    )
  ) {
    return "critical";
  }
  if (
    monitoring.hosts.some((host) => host.status === "stale") ||
    monitoring.containers.some((container) => container.status === "stale")
  ) {
    return "degraded";
  }
  return "operational";
}

function entityName(incident: ActiveIncident | RecoveredIncident): string {
  if (incident.entityType === "backup") return incident.backupTarget;
  return incident.containerName ?? incident.hostDisplayName;
}

function incidentActivity(incident: ActiveIncident): OverviewActivity | null {
  const occurredAt = incident.latestTransitionAt ?? incident.startedAt;
  if (!occurredAt) return null;
  return {
    id: `active:${incident.id}`,
    occurredAt,
    title: `${incident.severity === "critical" ? "重大" : "注意"}: ${entityName(incident)}`,
    detail: incident.latestTransition ?? incident.startReason,
    href: incident.detailHref,
    tone: incident.severity === "critical" ? "danger" : "warning",
  };
}

function recoveryActivity(incident: RecoveredIncident): OverviewActivity {
  return {
    id: `recovered:${incident.id}`,
    occurredAt: incident.recoveredAt,
    title: `復旧: ${entityName(incident)}`,
    detail: incident.recoveryReason,
    href: incident.detailHref,
    tone: "success",
  };
}

function recentActivities(
  incidents: UnifiedIncidentCenterSnapshot | null,
  notification: NotificationSummary | null,
  referenceAt: string,
): OverviewActivity[] {
  const activities: OverviewActivity[] = [];
  if (incidents) {
    for (const incident of incidents.active) {
      const activity = incidentActivity(incident);
      if (activity) activities.push(activity);
    }
    activities.push(...incidents.recovered.map(recoveryActivity));
  }
  if (notification?.lastDeliveryAt) {
    activities.push({
      id: `notification:${notification.lastDeliveryAt}`,
      occurredAt: notification.lastDeliveryAt,
      title: "通知配送を更新",
      detail: `${notification.channelDisplayName} / 24時間送信 ${notification.sent24hCount}件`,
      href: "/notifications",
      tone: notification.failedCount > 0 ? "danger" : "info",
    });
  }

  const rangeEnd = Date.parse(referenceAt);
  const rangeStart = rangeEnd - 24 * 60 * 60 * 1_000;
  return activities
    .filter((item) => {
      const occurredAt = Date.parse(item.occurredAt);
      return (
        Number.isFinite(occurredAt) &&
        Number.isFinite(rangeEnd) &&
        occurredAt >= rangeStart &&
        occurredAt <= rangeEnd
      );
    })
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
    .slice(0, 6);
}

export async function getOverviewSnapshot(): Promise<OverviewSnapshot> {
  const monitoringPromise = getMonitoringSnapshot();
  const [monitoringResult, minecraftResult, incidentsResult, notificationResult] =
    await Promise.allSettled([
      monitoringPromise,
      getMinecraftOverview(monitoringPromise),
      getUnifiedIncidentCenterSnapshot("24h"),
      getNotificationSummary(),
    ]);

  const monitoring = monitoringResult.status === "fulfilled" ? monitoringResult.value : null;
  const minecraft = minecraftResult.status === "fulfilled" ? minecraftResult.value : null;
  const incidents = incidentsResult.status === "fulfilled" ? incidentsResult.value : null;
  const notification = notificationResult.status === "fulfilled" ? notificationResult.value : null;

  if (monitoringResult.status === "rejected") {
    console.error("OverviewのMonitoring Snapshot取得に失敗しました", monitoringResult.reason);
  }
  if (minecraftResult.status === "rejected") {
    console.error("OverviewのMinecraft Snapshot取得に失敗しました", minecraftResult.reason);
  }
  if (incidentsResult.status === "rejected") {
    console.error("OverviewのIncident Snapshot取得に失敗しました", incidentsResult.reason);
  }
  if (notificationResult.status === "rejected") {
    console.error("OverviewのNotification Summary取得に失敗しました", notificationResult.reason);
  }

  const generatedAt = new Date().toISOString();
  const [hostService, containerService, backupService] = incidentServices(incidents);
  const notificationService = buildNotificationService(notification);
  const services = [hostService, containerService, backupService, notificationService];
  const staleOrOffline = monitoring
    ? monitoring.hosts.filter((host) => host.status === "stale" || host.status === "offline").length +
      monitoring.containers.filter(
        (container) => container.status === "stale" || container.status === "offline",
      ).length
    : null;
  const backupCritical =
    incidents?.backupDataAvailable === true
      ? incidents.active.filter(
          (incident) => incident.entityType === "backup" && incident.severity === "critical",
        ).length
      : null;

  return {
    generatedAt,
    monitoring,
    minecraft,
    incidents,
    notification,
    sources: {
      monitoring: monitoring !== null,
      minecraft: minecraft !== null,
      incidents: incidents !== null,
      backup: incidents?.backupDataAvailable === true,
      notifications: notification !== null,
    },
    status: {
      minecraft: minecraft?.status ?? "unknown",
      infrastructure: infrastructureHealth(monitoring),
      backup: backupService.health,
      notifications: notificationService.health,
      reliability: incidents ? overallHealth(services) : "unknown",
    },
    attention: {
      activeCritical: incidents?.summary.activeCriticalCount ?? null,
      activeWarning: incidents?.summary.activeWarningCount ?? null,
      failedNotifications: notification?.failedCount ?? null,
      backupCritical,
      staleOrOffline,
    },
    activities: recentActivities(incidents, notification, generatedAt),
  };
}
