import "server-only";

import { getReliabilityMaintenanceWindows } from "./reliability-maintenance";
import { buildReliabilityMaintenanceAdjustments } from "./reliability-maintenance-metrics";
import { getReliabilitySloPolicies } from "./reliability-slo";
import {
  getUnifiedIncidentCenterSnapshot,
  type UnifiedIncidentCenterSnapshot,
} from "./unified-incidents";
import type {
  ReliabilityBurnRateService,
  ReliabilityBurnRateState,
  ReliabilityBurnRateWindow,
  ReliabilityBurnWindowId,
  ReliabilityMaintenanceWindow,
  ReliabilitySloPolicy,
  ReliabilitySloServiceId,
} from "./reliability-types";

export const RELIABILITY_BURN_WINDOWS: ReadonlyArray<{
  id: ReliabilityBurnWindowId;
  label: string;
  hours: number;
}> = [
  { id: "1h", label: "1時間", hours: 1 },
  { id: "6h", label: "6時間", hours: 6 },
  { id: "24h", label: "24時間", hours: 24 },
];

export const RELIABILITY_BURN_POLICY = {
  critical: {
    shortWindow: "1h" as const,
    shortThreshold: 14.4,
    longWindow: "6h" as const,
    longThreshold: 6,
  },
  warning: {
    shortWindow: "6h" as const,
    shortThreshold: 6,
    longWindow: "24h" as const,
    longThreshold: 3,
  },
} as const;

const SLO_SERVICE_IDS: ReliabilitySloServiceId[] = [
  "overall",
  "host",
  "container",
  "backup",
];

const SERVICE_LABELS: Record<ReliabilitySloServiceId, string> = {
  overall: "Overall Reliability",
  host: "Host Platform",
  container: "Container Runtime",
  backup: "Backup Protection",
};

function findWindow(
  windows: ReliabilityBurnRateWindow[],
  id: ReliabilityBurnWindowId,
): ReliabilityBurnRateWindow | null {
  return windows.find((window) => window.windowId === id) ?? null;
}

function reaches(
  window: ReliabilityBurnRateWindow | null,
  threshold: number,
): boolean {
  return Boolean(
    window?.exactCoverage &&
    window.burnRate !== null &&
    Number.isFinite(window.burnRate) &&
    window.burnRate >= threshold,
  );
}

function stateFor(windows: ReliabilityBurnRateWindow[]): ReliabilityBurnRateState {
  const criticalShort = findWindow(windows, RELIABILITY_BURN_POLICY.critical.shortWindow);
  const criticalLong = findWindow(windows, RELIABILITY_BURN_POLICY.critical.longWindow);
  if (
    reaches(criticalShort, RELIABILITY_BURN_POLICY.critical.shortThreshold) &&
    reaches(criticalLong, RELIABILITY_BURN_POLICY.critical.longThreshold)
  ) {
    return "critical";
  }

  const warningShort = findWindow(windows, RELIABILITY_BURN_POLICY.warning.shortWindow);
  const warningLong = findWindow(windows, RELIABILITY_BURN_POLICY.warning.longWindow);
  if (
    reaches(warningShort, RELIABILITY_BURN_POLICY.warning.shortThreshold) &&
    reaches(warningLong, RELIABILITY_BURN_POLICY.warning.longThreshold)
  ) {
    return "warning";
  }

  return windows.every((window) => window.exactCoverage)
    ? "healthy"
    : "coverage_unknown";
}

function reasonFor(
  state: ReliabilityBurnRateState,
  windows: ReliabilityBurnRateWindow[],
): string {
  const value = (id: ReliabilityBurnWindowId): string => {
    const window = findWindow(windows, id);
    if (!window || window.burnRate === null) return `${id}=—`;
    const prefix = window.exactCoverage ? "" : "≥";
    return `${id}=${prefix}${window.burnRate.toFixed(window.burnRate >= 10 ? 1 : 2)}x`;
  };

  const rates = `${value("1h")} / ${value("6h")} / ${value("24h")}`;
  switch (state) {
    case "critical":
      return `Fast Burnを検知しました。${rates}`;
    case "warning":
      return `Sustained Burnを検知しました。${rates}`;
    case "healthy":
      return `Burn Rateは通知閾値内です。${rates}`;
    case "coverage_unknown":
      return `Coverageが不完全なためRecoveryを確定しません。${rates}`;
    case "unconfigured":
      return "SLO Policyが未設定または無効です。";
    case "data_unavailable":
      return "SLO PolicyまたはMaintenanceデータを取得できません。";
  }
}

function buildConfiguredWindows(
  incidents: UnifiedIncidentCenterSnapshot,
  maintenanceWindows: ReliabilityMaintenanceWindow[],
  policy: ReliabilitySloPolicy,
  serviceId: ReliabilitySloServiceId,
): ReliabilityBurnRateWindow[] {
  const rangeEnd = Date.parse(incidents.generatedAt);
  const backupCoverageRequired = serviceId === "overall" || serviceId === "backup";

  return RELIABILITY_BURN_WINDOWS.map((window): ReliabilityBurnRateWindow => {
    const rangeStart = rangeEnd - window.hours * 3_600_000;
    const adjustment = buildReliabilityMaintenanceAdjustments(
      incidents.active,
      incidents.recovered,
      maintenanceWindows,
      rangeStart,
      rangeEnd,
    ).find((candidate) => candidate.serviceId === serviceId);

    if (!adjustment || policy.targetPercent === null) {
      return {
        windowId: window.id,
        label: window.label,
        hours: window.hours,
        rawDowntimeSeconds: null,
        maintenanceExcludedSeconds: null,
        countedDowntimeSeconds: null,
        allowedDowntimeSeconds: null,
        burnRate: null,
        exactCoverage: false,
      };
    }

    const windowSeconds = window.hours * 3_600;
    const allowedDowntimeSeconds = windowSeconds * (1 - policy.targetPercent / 100);
    const burnRate = adjustment.countedDowntimeSeconds / allowedDowntimeSeconds;
    return {
      windowId: window.id,
      label: window.label,
      hours: window.hours,
      rawDowntimeSeconds: adjustment.rawDowntimeSeconds,
      maintenanceExcludedSeconds: adjustment.excludedMaintenanceSeconds,
      countedDowntimeSeconds: adjustment.countedDowntimeSeconds,
      allowedDowntimeSeconds,
      burnRate: Number.isFinite(burnRate) ? burnRate : null,
      exactCoverage:
        adjustment.exactCoverage &&
        (!backupCoverageRequired || incidents.backupDataAvailable),
    };
  });
}

export function buildReliabilityBurnRates(
  incidents: UnifiedIncidentCenterSnapshot,
  policies: ReliabilitySloPolicy[] | null,
  maintenanceWindows: ReliabilityMaintenanceWindow[] | null,
): ReliabilityBurnRateService[] {
  const policyByService = new Map(
    (policies ?? []).map((policy) => [policy.serviceId, policy]),
  );

  return SLO_SERVICE_IDS.map((serviceId): ReliabilityBurnRateService => {
    const policy = policyByService.get(serviceId) ?? null;
    const base = {
      serviceId,
      label: SERVICE_LABELS[serviceId],
      targetPercent: policy?.targetPercent ?? null,
      enabled: policy?.enabled ?? false,
    };

    if (policies === null || maintenanceWindows === null) {
      return {
        ...base,
        state: "data_unavailable",
        reason: reasonFor("data_unavailable", []),
        windows: [],
      };
    }

    if (!policy || !policy.enabled || policy.targetPercent === null) {
      return {
        ...base,
        state: "unconfigured",
        reason: reasonFor("unconfigured", []),
        windows: [],
      };
    }

    const windows = buildConfiguredWindows(
      incidents,
      maintenanceWindows,
      policy,
      serviceId,
    );
    const state = stateFor(windows);
    return {
      ...base,
      state,
      reason: reasonFor(state, windows),
      windows,
    };
  });
}

export async function getReliabilityBurnRateSnapshot(): Promise<{
  generatedAt: string;
  burnRates: ReliabilityBurnRateService[];
}> {
  const requestedAt = Date.now();
  const provisionalStart = new Date(requestedAt - 24 * 3_600_000 - 60_000).toISOString();
  const provisionalEnd = new Date(requestedAt).toISOString();

  const [incidents, policiesResult, maintenanceResult] = await Promise.all([
    getUnifiedIncidentCenterSnapshot("24h"),
    getReliabilitySloPolicies()
      .then((policies) => ({ ok: true as const, policies }))
      .catch((error: unknown) => {
        console.error("Burn Rate評価のSLO Policy取得に失敗しました", error);
        return { ok: false as const, policies: null };
      }),
    getReliabilityMaintenanceWindows({
      rangeStart: provisionalStart,
      generatedAt: provisionalEnd,
    })
      .then((windows) => ({ ok: true as const, windows }))
      .catch((error: unknown) => {
        console.error("Burn Rate評価のMaintenance取得に失敗しました", error);
        return { ok: false as const, windows: null };
      }),
  ]);

  return {
    generatedAt: incidents.generatedAt,
    burnRates: buildReliabilityBurnRates(
      incidents,
      policiesResult.policies,
      maintenanceResult.windows,
    ),
  };
}
