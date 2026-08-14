import type { IncidentRange } from "./unified-incidents";

export type ReliabilityRange = IncidentRange;
export type ReliabilityHealth = "operational" | "degraded" | "critical" | "disabled" | "unknown";
export type ReliabilityServiceId = "host" | "container" | "backup" | "notifications";
export type ReliabilitySloServiceId = "overall" | Exclude<ReliabilityServiceId, "notifications">;
export type ReliabilitySloBudgetState =
  | "unconfigured"
  | "within_budget"
  | "exhausted"
  | "coverage_unknown"
  | "data_unavailable";

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

export type ReliabilitySloPolicy = {
  serviceId: ReliabilitySloServiceId;
  targetPercent: number | null;
  enabled: boolean;
  updatedAt: string;
};

export type ReliabilitySloBudget = {
  serviceId: ReliabilitySloServiceId;
  label: string;
  state: ReliabilitySloBudgetState;
  targetPercent: number | null;
  enabled: boolean;
  updatedAt: string | null;
  observedAvailabilityPercent: number | null;
  observedExact: boolean;
  knownDowntimeSeconds: number | null;
  allowedDowntimeSeconds: number | null;
  remainingBudgetSeconds: number | null;
  remainingExact: boolean;
  budgetUsedPercent: number | null;
  burnRate: number | null;
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
  sloPolicyDataAvailable: boolean;
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
  sloBudgets: ReliabilitySloBudget[];
  notifications: NotificationReliability;
};
