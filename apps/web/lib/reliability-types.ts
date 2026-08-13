import type { IncidentRange } from "./unified-incidents";

export type ReliabilityRange = IncidentRange;
export type ReliabilityHealth = "operational" | "degraded" | "critical" | "disabled" | "unknown";
export type ReliabilityServiceId = "host" | "container" | "backup" | "notifications";

export type ReliabilityService = {
  id: ReliabilityServiceId;
  label: string;
  description: string;
  health: ReliabilityHealth;
  activeIncidentCount: number;
  activeCriticalCount: number;
  activeWarningCount: number;
  recoveredIncidentCount: number;
  knownDowntimeSeconds: number | null;
  incidentFreeRatio: number | null;
  exactCoverage: boolean;
  medianRecoverySeconds: number | null;
  longestRecoverySeconds: number | null;
  latestRecoveredAt: string | null;
  affectedEntityCount: number;
  detailHref: string;
};

export type NotificationReliability = {
  enabled: boolean | null;
  configured: boolean | null;
  pendingCount: number | null;
  retryCount: number | null;
  failedCount: number | null;
  suppressedCount: number | null;
  sent24hCount: number | null;
  activeSuppressionCount: number | null;
  lastDeliveryAt: string | null;
  dispatcherLastSuccessAt: string | null;
  lastErrorCode: string | null;
};

export type ReliabilitySnapshot = {
  generatedAt: string;
  range: ReliabilityRange;
  backupDataAvailable: boolean;
  notificationDataAvailable: boolean;
  overall: {
    health: ReliabilityHealth;
    activeIncidentCount: number;
    activeCriticalCount: number;
    knownDowntimeSeconds: number;
    incidentFreeRatio: number;
    exactCoverage: boolean;
    recoveredIncidentCount: number;
    medianRecoverySeconds: number | null;
    longestRecoverySeconds: number | null;
    affectedEntityCount: number;
  };
  services: ReliabilityService[];
  notifications: NotificationReliability;
};
