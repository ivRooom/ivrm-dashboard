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
export type ReliabilityMaintenanceScopeType = "service" | "host" | "container" | "backup";

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

export type ReliabilityMaintenanceWindow = {
  id: string;
  scopeType: ReliabilityMaintenanceScopeType;
  serviceId: ReliabilitySloServiceId | null;
  hostId: string | null;
  serverId: string | null;
  hostDisplayName: string | null;
  containerName: string | null;
  backupTarget: string | null;
  gameMode: string | null;
  backupType: "world" | "config" | "permissions" | "full" | null;
  startsAt: string;
  endsAt: string;
  reason: string;
  cancelledAt: string | null;
  createdAt: string;
};

export type ReliabilityMaintenanceTargetCatalog = {
  hosts: Array<{
    hostId: string;
    serverId: string;
    displayName: string;
  }>;
  containers: Array<{
    hostId: string;
    serverId: string;
    hostDisplayName: string;
    containerName: string;
  }>;
  backups: Array<{
    hostId: string;
    serverId: string;
    hostDisplayName: string;
    backupTarget: string;
    gameMode: string;
    backupType: "world" | "config" | "permissions" | "full";
  }>;
};

export type ReliabilitySloMaintenanceAdjustment = {
  serviceId: ReliabilitySloServiceId;
  rawDowntimeSeconds: number;
  countedDowntimeSeconds: number;
  excludedMaintenanceSeconds: number;
  exactCoverage: boolean;
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
  rawDowntimeSeconds: number | null;
  knownDowntimeSeconds: number | null;
  maintenanceExcludedSeconds: number | null;
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
  maintenanceDataAvailable: boolean;
  maintenanceWindows: ReliabilityMaintenanceWindow[];
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
