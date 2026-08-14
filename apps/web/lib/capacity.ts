import "server-only";

import {
  getBackupCenterSnapshot,
  type BackupCenterSnapshot,
  type BackupHistoryRun,
} from "./backups";
import {
  getContainerMetricHistory,
  getHostMetricHistory,
  type ContainerMetricHistorySeries,
  type HostMetricHistorySeries,
} from "./history";
import {
  getMonitoringSnapshot,
  type ContainerOverview,
  type HostOverview,
} from "./monitoring";

export const CAPACITY_RANGE_CONFIG = {
  "24h": { label: "24時間", hours: 24, refreshMs: 60_000 },
  "7d": { label: "7日", hours: 24 * 7, refreshMs: 120_000 },
  "30d": { label: "30日", hours: 24 * 30, refreshMs: 300_000 },
} as const;

export const CAPACITY_POLICY = {
  disk: { warningPercent: 80, criticalPercent: 90 },
  memory: { warningPercent: 85, criticalPercent: 95 },
  forecast: {
    minimumPointCount: 24,
    minimumCoverageRatio: 0.4,
    minimumSpanRatio: 0.5,
    minimumRSquared: 0.3,
    mediumRSquared: 0.5,
    highRSquared: 0.75,
    mediumCoverageRatio: 0.65,
    highCoverageRatio: 0.8,
    minimumGrowthPercentPerDay: 0.05,
    warningHorizonDays: 30,
    criticalHorizonDays: 7,
    maximumForecastDays: 365,
  },
  backup: {
    minimumPointCount: 3,
    minimumSpanRatio: 0.15,
    minimumRSquared: 0.25,
    materialGrowthBytesPerDay: 1_048_576,
  },
} as const;

export type CapacityRange = keyof typeof CAPACITY_RANGE_CONFIG;
export type CapacityResourceKind = "disk" | "memory" | "container_memory";
export type ForecastConfidence = "high" | "medium" | "low" | "insufficient";
export type CapacityState =
  | "healthy"
  | "growth"
  | "forecast_warning"
  | "forecast_critical"
  | "warning"
  | "critical"
  | "insufficient";
export type BackupGrowthState = "growth" | "stable" | "shrinking" | "insufficient";

export type CapacityForecast = {
  currentPercent: number | null;
  state: CapacityState;
  slopePercentPerDay: number | null;
  rSquared: number | null;
  confidence: ForecastConfidence;
  coverageRatio: number;
  spanRatio: number;
  validPointCount: number;
  expectedPointCount: number;
  daysToWarning: number | null;
  daysToCritical: number | null;
  warningPercent: number;
  criticalPercent: number;
  reason: string;
};

export type HostCapacityResource = {
  id: string;
  hostId: string;
  serverId: string | null;
  hostDisplayName: string;
  kind: "disk" | "memory";
  totalBytes: number | null;
  availableBytes: number | null;
  detailHref: string | null;
  forecast: CapacityForecast;
};

export type ContainerCapacityResource = {
  id: string;
  hostId: string;
  serverId: string | null;
  hostDisplayName: string;
  containerName: string;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number | null;
  detailHref: string | null;
  forecast: CapacityForecast;
};

export type BackupGrowthForecast = {
  id: string;
  hostId: string;
  hostDisplayName: string;
  backupTarget: string;
  latestSizeBytes: number | null;
  growthBytesPerDay: number | null;
  growthPercentPerDay: number | null;
  rSquared: number | null;
  confidence: ForecastConfidence;
  state: BackupGrowthState;
  sampleCount: number;
  spanRatio: number;
  reason: string;
};

export type CapacitySnapshot = {
  generatedAt: string;
  range: CapacityRange;
  sources: {
    monitoring: boolean;
    hostHistory: boolean;
    containerHistory: boolean;
    backups: boolean;
  };
  hostResources: HostCapacityResource[];
  containerResources: ContainerCapacityResource[];
  backupGrowth: BackupGrowthForecast[];
  hostHistory: HostMetricHistorySeries[];
  containerHistory: ContainerMetricHistorySeries[];
  summary: {
    forecastAttentionCount: number;
    criticalCount: number;
    warningCount: number;
    growthCount: number;
    insufficientCount: number;
    backupGrowthCount: number;
  };
};

type PercentTrendPoint = {
  timestamp: string;
  value: number | null;
  sampleCount: number;
};

type RegressionPoint = {
  timestamp: string;
  value: number;
  weight: number;
};

type Regression = {
  slopePerDay: number;
  rSquared: number;
  pointCount: number;
  spanDays: number;
};

const MAX_ACCEPTED_PERCENT = 200;

export function parseCapacityRange(value: string | null | undefined): CapacityRange {
  return value && Object.hasOwn(CAPACITY_RANGE_CONFIG, value)
    ? (value as CapacityRange)
    : "30d";
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentFromCapacity(totalBytes: number | null, availableBytes: number | null): number | null {
  if (
    totalBytes === null ||
    availableBytes === null ||
    !Number.isFinite(totalBytes) ||
    !Number.isFinite(availableBytes) ||
    totalBytes <= 0 ||
    availableBytes < 0
  ) {
    return null;
  }
  return Math.max(0, ((totalBytes - availableBytes) / totalBytes) * 100);
}

function percentFromContainer(container: ContainerOverview | null): number | null {
  if (
    !container ||
    container.memoryUsageBytes === null ||
    container.memoryLimitBytes === null ||
    container.memoryLimitBytes <= 0
  ) {
    return null;
  }
  return Math.max(0, (container.memoryUsageBytes / container.memoryLimitBytes) * 100);
}

function latestPercent(points: PercentTrendPoint[]): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = points[index]?.value;
    if (value !== null && Number.isFinite(value)) return value;
  }
  return null;
}

function regression(points: RegressionPoint[]): Regression | null {
  if (points.length < 2) return null;
  const sorted = [...points].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  const firstTime = Date.parse(sorted[0].timestamp);
  const lastTime = Date.parse(sorted.at(-1)?.timestamp ?? sorted[0].timestamp);
  if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime) || lastTime <= firstTime) return null;

  const normalized = sorted.flatMap((point) => {
    const timestamp = Date.parse(point.timestamp);
    if (!Number.isFinite(timestamp) || !Number.isFinite(point.value) || point.weight <= 0) return [];
    return [{ x: (timestamp - firstTime) / 86_400_000, y: point.value, w: point.weight }];
  });
  if (normalized.length < 2) return null;

  const totalWeight = normalized.reduce((sum, point) => sum + point.w, 0);
  if (totalWeight <= 0) return null;
  const meanX = normalized.reduce((sum, point) => sum + point.x * point.w, 0) / totalWeight;
  const meanY = normalized.reduce((sum, point) => sum + point.y * point.w, 0) / totalWeight;
  const varianceX = normalized.reduce(
    (sum, point) => sum + point.w * (point.x - meanX) ** 2,
    0,
  );
  if (varianceX <= Number.EPSILON) return null;
  const covariance = normalized.reduce(
    (sum, point) => sum + point.w * (point.x - meanX) * (point.y - meanY),
    0,
  );
  const slopePerDay = covariance / varianceX;
  const intercept = meanY - slopePerDay * meanX;
  const totalVarianceY = normalized.reduce(
    (sum, point) => sum + point.w * (point.y - meanY) ** 2,
    0,
  );
  const residual = normalized.reduce(
    (sum, point) => sum + point.w * (point.y - (intercept + slopePerDay * point.x)) ** 2,
    0,
  );
  const rSquared = totalVarianceY <= Number.EPSILON
    ? 1
    : Math.max(0, Math.min(1, 1 - residual / totalVarianceY));

  return {
    slopePerDay,
    rSquared,
    pointCount: normalized.length,
    spanDays: (lastTime - firstTime) / 86_400_000,
  };
}

function confidenceFor(
  rSquared: number,
  coverageRatio: number,
  spanRatio: number,
): Exclude<ForecastConfidence, "insufficient"> {
  const policy = CAPACITY_POLICY.forecast;
  if (
    rSquared >= policy.highRSquared &&
    coverageRatio >= policy.highCoverageRatio &&
    spanRatio >= policy.highCoverageRatio
  ) {
    return "high";
  }
  if (
    rSquared >= policy.mediumRSquared &&
    coverageRatio >= policy.mediumCoverageRatio &&
    spanRatio >= policy.mediumCoverageRatio
  ) {
    return "medium";
  }
  return "low";
}

function daysToThreshold(current: number, slopePerDay: number, threshold: number): number | null {
  const policy = CAPACITY_POLICY.forecast;
  if (current >= threshold) return 0;
  if (slopePerDay < policy.minimumGrowthPercentPerDay) return null;
  const days = (threshold - current) / slopePerDay;
  return days >= 0 && days <= policy.maximumForecastDays ? days : null;
}

function percentForecast(
  points: PercentTrendPoint[],
  currentOverride: number | null,
  bucketSeconds: number,
  range: CapacityRange,
  thresholds: { warningPercent: number; criticalPercent: number },
): CapacityForecast {
  const rangeConfig = CAPACITY_RANGE_CONFIG[range];
  const valid = points.flatMap((point): RegressionPoint[] => {
    if (
      point.value === null ||
      !Number.isFinite(point.value) ||
      point.value < 0 ||
      point.value > MAX_ACCEPTED_PERCENT ||
      !Number.isFinite(Date.parse(point.timestamp))
    ) {
      return [];
    }
    return [{ timestamp: point.timestamp, value: point.value, weight: Math.max(1, point.sampleCount) }];
  });
  const expectedPointCount = Math.max(1, Math.floor((rangeConfig.hours * 3_600) / Math.max(1, bucketSeconds)));
  const coverageRatio = Math.min(1, valid.length / expectedPointCount);
  const fitted = regression(valid);
  const spanRatio = fitted
    ? Math.min(1, fitted.spanDays / Math.max(1 / 24, rangeConfig.hours / 24))
    : 0;
  const currentPercent = finiteNumber(currentOverride) ?? latestPercent(points);
  const policy = CAPACITY_POLICY.forecast;

  if (currentPercent === null) {
    return {
      currentPercent: null,
      state: "insufficient",
      slopePercentPerDay: fitted?.slopePerDay ?? null,
      rSquared: fitted?.rSquared ?? null,
      confidence: "insufficient",
      coverageRatio,
      spanRatio,
      validPointCount: valid.length,
      expectedPointCount,
      daysToWarning: null,
      daysToCritical: null,
      warningPercent: thresholds.warningPercent,
      criticalPercent: thresholds.criticalPercent,
      reason: "現在使用率を算出できません",
    };
  }

  if (currentPercent >= thresholds.criticalPercent) {
    return {
      currentPercent,
      state: "critical",
      slopePercentPerDay: fitted?.slopePerDay ?? null,
      rSquared: fitted?.rSquared ?? null,
      confidence: fitted ? confidenceFor(fitted.rSquared, coverageRatio, spanRatio) : "insufficient",
      coverageRatio,
      spanRatio,
      validPointCount: valid.length,
      expectedPointCount,
      daysToWarning: 0,
      daysToCritical: 0,
      warningPercent: thresholds.warningPercent,
      criticalPercent: thresholds.criticalPercent,
      reason: `Criticalしきい値 ${thresholds.criticalPercent}% に到達しています`,
    };
  }

  if (currentPercent >= thresholds.warningPercent) {
    const usable = Boolean(
      fitted &&
      valid.length >= policy.minimumPointCount &&
      coverageRatio >= policy.minimumCoverageRatio &&
      spanRatio >= policy.minimumSpanRatio &&
      fitted.rSquared >= policy.minimumRSquared,
    );
    const daysToCritical = usable && fitted
      ? daysToThreshold(currentPercent, fitted.slopePerDay, thresholds.criticalPercent)
      : null;
    return {
      currentPercent,
      state: "warning",
      slopePercentPerDay: fitted?.slopePerDay ?? null,
      rSquared: fitted?.rSquared ?? null,
      confidence: usable && fitted ? confidenceFor(fitted.rSquared, coverageRatio, spanRatio) : "insufficient",
      coverageRatio,
      spanRatio,
      validPointCount: valid.length,
      expectedPointCount,
      daysToWarning: 0,
      daysToCritical,
      warningPercent: thresholds.warningPercent,
      criticalPercent: thresholds.criticalPercent,
      reason: `Warningしきい値 ${thresholds.warningPercent}% に到達しています`,
    };
  }

  if (!fitted || valid.length < policy.minimumPointCount) {
    return {
      currentPercent,
      state: "insufficient",
      slopePercentPerDay: fitted?.slopePerDay ?? null,
      rSquared: fitted?.rSquared ?? null,
      confidence: "insufficient",
      coverageRatio,
      spanRatio,
      validPointCount: valid.length,
      expectedPointCount,
      daysToWarning: null,
      daysToCritical: null,
      warningPercent: thresholds.warningPercent,
      criticalPercent: thresholds.criticalPercent,
      reason: `予測に必要な有効サンプルが不足しています（${valid.length}/${policy.minimumPointCount}）`,
    };
  }
  if (coverageRatio < policy.minimumCoverageRatio || spanRatio < policy.minimumSpanRatio) {
    return {
      currentPercent,
      state: "insufficient",
      slopePercentPerDay: fitted.slopePerDay,
      rSquared: fitted.rSquared,
      confidence: "insufficient",
      coverageRatio,
      spanRatio,
      validPointCount: valid.length,
      expectedPointCount,
      daysToWarning: null,
      daysToCritical: null,
      warningPercent: thresholds.warningPercent,
      criticalPercent: thresholds.criticalPercent,
      reason: "観測期間またはデータ被覆率が不足しているため予測を保留しています",
    };
  }
  if (fitted.rSquared < policy.minimumRSquared) {
    return {
      currentPercent,
      state: "insufficient",
      slopePercentPerDay: fitted.slopePerDay,
      rSquared: fitted.rSquared,
      confidence: "insufficient",
      coverageRatio,
      spanRatio,
      validPointCount: valid.length,
      expectedPointCount,
      daysToWarning: null,
      daysToCritical: null,
      warningPercent: thresholds.warningPercent,
      criticalPercent: thresholds.criticalPercent,
      reason: "変動が大きく、直線傾向として十分に説明できないため予測を保留しています",
    };
  }

  const confidence = confidenceFor(fitted.rSquared, coverageRatio, spanRatio);
  const daysToWarning = daysToThreshold(currentPercent, fitted.slopePerDay, thresholds.warningPercent);
  const daysToCritical = daysToThreshold(currentPercent, fitted.slopePerDay, thresholds.criticalPercent);
  let state: CapacityState = "healthy";
  let reason = "安定または減少傾向です";
  if (daysToCritical !== null && daysToCritical <= policy.criticalHorizonDays) {
    state = "forecast_critical";
    reason = `現在傾向が続く場合、Critical到達まで約${Math.max(1, Math.ceil(daysToCritical))}日です`;
  } else if (daysToWarning !== null && daysToWarning <= policy.warningHorizonDays) {
    state = "forecast_warning";
    reason = `現在傾向が続く場合、Warning到達まで約${Math.max(1, Math.ceil(daysToWarning))}日です`;
  } else if (fitted.slopePerDay >= policy.minimumGrowthPercentPerDay) {
    state = "growth";
    reason = "増加傾向を検出しましたが、30日以内のWarning到達は予測されていません";
  }

  return {
    currentPercent,
    state,
    slopePercentPerDay: fitted.slopePerDay,
    rSquared: fitted.rSquared,
    confidence,
    coverageRatio,
    spanRatio,
    validPointCount: valid.length,
    expectedPointCount,
    daysToWarning,
    daysToCritical,
    warningPercent: thresholds.warningPercent,
    criticalPercent: thresholds.criticalPercent,
    reason,
  };
}

function backupGrowthForecast(
  target: BackupCenterSnapshot["targets"][number],
  runs: BackupHistoryRun[],
  range: CapacityRange,
): BackupGrowthForecast {
  const points = runs.flatMap((run): RegressionPoint[] => {
    if (run.outcome !== "success" || run.sizeBytes === null || run.sizeBytes < 0 || !run.completedAt) return [];
    return [{ timestamp: run.completedAt, value: run.sizeBytes, weight: 1 }];
  });
  const fitted = regression(points);
  const rangeDays = CAPACITY_RANGE_CONFIG[range].hours / 24;
  const spanRatio = fitted ? Math.min(1, fitted.spanDays / Math.max(1 / 24, rangeDays)) : 0;
  const latestSizeBytes = target.latestSuccess?.sizeBytes ?? null;
  const policy = CAPACITY_POLICY.backup;
  const enoughData = Boolean(
    fitted &&
    points.length >= policy.minimumPointCount &&
    spanRatio >= policy.minimumSpanRatio &&
    fitted.rSquared >= policy.minimumRSquared,
  );
  const growthBytesPerDay = fitted?.slopePerDay ?? null;
  const growthPercentPerDay =
    growthBytesPerDay !== null && latestSizeBytes !== null && latestSizeBytes > 0
      ? (growthBytesPerDay / latestSizeBytes) * 100
      : null;

  if (!enoughData || !fitted) {
    return {
      id: `${target.hostId}:${target.backupTarget}:${target.backupType}`,
      hostId: target.hostId,
      hostDisplayName: target.hostDisplayName,
      backupTarget: target.backupTarget,
      latestSizeBytes,
      growthBytesPerDay,
      growthPercentPerDay,
      rSquared: fitted?.rSquared ?? null,
      confidence: "insufficient",
      state: "insufficient",
      sampleCount: points.length,
      spanRatio,
      reason: "Backupサイズ傾向を判定する履歴が不足しています",
    };
  }

  const confidence: Exclude<ForecastConfidence, "insufficient"> =
    fitted.rSquared >= CAPACITY_POLICY.forecast.highRSquared && spanRatio >= CAPACITY_POLICY.forecast.highCoverageRatio
      ? "high"
      : fitted.rSquared >= CAPACITY_POLICY.forecast.mediumRSquared && spanRatio >= CAPACITY_POLICY.forecast.mediumCoverageRatio
        ? "medium"
        : "low";
  const material = policy.materialGrowthBytesPerDay;
  const state: BackupGrowthState = fitted.slopePerDay > material
    ? "growth"
    : fitted.slopePerDay < -material
      ? "shrinking"
      : "stable";
  const reason = state === "growth"
    ? "Backupサイズの増加傾向を検出しています"
    : state === "shrinking"
      ? "Backupサイズは減少傾向です"
      : "Backupサイズは概ね安定しています";

  return {
    id: `${target.hostId}:${target.backupTarget}:${target.backupType}`,
    hostId: target.hostId,
    hostDisplayName: target.hostDisplayName,
    backupTarget: target.backupTarget,
    latestSizeBytes,
    growthBytesPerDay: fitted.slopePerDay,
    growthPercentPerDay,
    rSquared: fitted.rSquared,
    confidence,
    state,
    sampleCount: points.length,
    spanRatio,
    reason,
  };
}

function historyHostName(series: HostMetricHistorySeries | undefined, host: HostOverview | undefined): string {
  return host?.displayName ?? series?.hostDisplayName ?? "Unknown Host";
}

export async function getCapacitySnapshot(range: CapacityRange): Promise<CapacitySnapshot> {
  const [monitoringResult, hostHistoryResult, containerHistoryResult, backupResult] = await Promise.allSettled([
    getMonitoringSnapshot(),
    getHostMetricHistory(range),
    getContainerMetricHistory(range),
    getBackupCenterSnapshot(range),
  ]);

  if (monitoringResult.status === "rejected") {
    console.error("Capacity CenterのMonitoring Snapshot取得に失敗しました", monitoringResult.reason);
  }
  if (hostHistoryResult.status === "rejected") {
    console.error("Capacity CenterのHost History取得に失敗しました", hostHistoryResult.reason);
  }
  if (containerHistoryResult.status === "rejected") {
    console.error("Capacity CenterのContainer History取得に失敗しました", containerHistoryResult.reason);
  }
  if (backupResult.status === "rejected") {
    console.error("Capacity CenterのBackup History取得に失敗しました", backupResult.reason);
  }

  const monitoring = monitoringResult.status === "fulfilled" ? monitoringResult.value : null;
  const hostHistory = hostHistoryResult.status === "fulfilled" ? hostHistoryResult.value : [];
  const containerHistory = containerHistoryResult.status === "fulfilled" ? containerHistoryResult.value : [];
  const backups = backupResult.status === "fulfilled" ? backupResult.value : null;

  const monitoringHosts = new Map(monitoring?.hosts.map((host) => [host.id, host]) ?? []);
  const historyHosts = new Map(hostHistory.map((series) => [series.hostId, series]));
  const hostIds = new Set([...monitoringHosts.keys(), ...historyHosts.keys()]);
  const hostResources: HostCapacityResource[] = [];

  for (const hostId of hostIds) {
    const host = monitoringHosts.get(hostId);
    const series = historyHosts.get(hostId);
    const hostDisplayName = historyHostName(series, host);
    const serverId = host?.serverId ?? null;
    const detailHref = serverId ? `/hosts/${encodeURIComponent(serverId)}` : null;
    const bucketSeconds = series?.bucketSeconds ?? 3_600;
    const diskPoints: PercentTrendPoint[] = series?.points.map((point) => ({
      timestamp: point.timestamp,
      value: point.diskPercent,
      sampleCount: point.sampleCount,
    })) ?? [];
    const memoryPoints: PercentTrendPoint[] = series?.points.map((point) => ({
      timestamp: point.timestamp,
      value: point.memoryPercent,
      sampleCount: point.sampleCount,
    })) ?? [];

    hostResources.push({
      id: `${hostId}:disk`,
      hostId,
      serverId,
      hostDisplayName,
      kind: "disk",
      totalBytes: host?.diskTotalBytes ?? null,
      availableBytes: host?.diskAvailableBytes ?? null,
      detailHref,
      forecast: percentForecast(
        diskPoints,
        host ? percentFromCapacity(host.diskTotalBytes, host.diskAvailableBytes) : null,
        bucketSeconds,
        range,
        CAPACITY_POLICY.disk,
      ),
    });
    hostResources.push({
      id: `${hostId}:memory`,
      hostId,
      serverId,
      hostDisplayName,
      kind: "memory",
      totalBytes: host?.memoryTotalBytes ?? null,
      availableBytes: host?.memoryAvailableBytes ?? null,
      detailHref,
      forecast: percentForecast(
        memoryPoints,
        host ? percentFromCapacity(host.memoryTotalBytes, host.memoryAvailableBytes) : null,
        bucketSeconds,
        range,
        CAPACITY_POLICY.memory,
      ),
    });
  }

  const monitoringContainers = new Map(
    monitoring?.containers.map((container) => [`${container.hostId}:${container.name}`, container]) ?? [],
  );
  const historyContainers = new Map(
    containerHistory.map((series) => [`${series.hostId}:${series.containerName}`, series]),
  );
  const serverIdByHost = new Map(monitoring?.hosts.map((host) => [host.id, host.serverId]) ?? []);
  const containerKeys = new Set([...monitoringContainers.keys(), ...historyContainers.keys()]);
  const containerResources: ContainerCapacityResource[] = [];

  for (const key of containerKeys) {
    const container = monitoringContainers.get(key) ?? null;
    const series = historyContainers.get(key);
    const hostId = container?.hostId ?? series?.hostId;
    const containerName = container?.name ?? series?.containerName;
    if (!hostId || !containerName) continue;
    const serverId = serverIdByHost.get(hostId) ?? null;
    const memoryPoints: PercentTrendPoint[] = series?.points.map((point) => ({
      timestamp: point.timestamp,
      value: point.memoryPercent,
      sampleCount: point.sampleCount,
    })) ?? [];
    containerResources.push({
      id: `${hostId}:${containerName}`,
      hostId,
      serverId,
      hostDisplayName: container?.hostDisplayName ?? series?.hostDisplayName ?? "Unknown Host",
      containerName,
      memoryUsageBytes: container?.memoryUsageBytes ?? null,
      memoryLimitBytes: container?.memoryLimitBytes ?? null,
      detailHref: serverId
        ? `/containers/${encodeURIComponent(serverId)}/${encodeURIComponent(containerName)}`
        : null,
      forecast: percentForecast(
        memoryPoints,
        percentFromContainer(container),
        series?.bucketSeconds ?? 3_600,
        range,
        CAPACITY_POLICY.memory,
      ),
    });
  }

  const backupGrowth: BackupGrowthForecast[] = [];
  if (backups) {
    for (const target of backups.targets) {
      const matchingRuns = backups.history.filter(
        (run) =>
          run.hostId === target.hostId &&
          run.backupTarget === target.backupTarget &&
          run.backupType === target.backupType,
      );
      backupGrowth.push(backupGrowthForecast(target, matchingRuns, range));
    }
  }

  hostResources.sort((left, right) =>
    `${left.hostDisplayName}:${left.kind}`.localeCompare(`${right.hostDisplayName}:${right.kind}`, "ja"),
  );
  containerResources.sort((left, right) =>
    `${left.hostDisplayName}:${left.containerName}`.localeCompare(
      `${right.hostDisplayName}:${right.containerName}`,
      "ja",
    ),
  );
  backupGrowth.sort((left, right) =>
    `${left.hostDisplayName}:${left.backupTarget}`.localeCompare(
      `${right.hostDisplayName}:${right.backupTarget}`,
      "ja",
    ),
  );

  const forecasts = [
    ...hostResources.map((resource) => resource.forecast),
    ...containerResources.map((resource) => resource.forecast),
  ];
  const criticalCount = forecasts.filter(
    (forecast) => forecast.state === "critical" || forecast.state === "forecast_critical",
  ).length;
  const warningCount = forecasts.filter(
    (forecast) => forecast.state === "warning" || forecast.state === "forecast_warning",
  ).length;
  const growthCount = forecasts.filter((forecast) => forecast.state === "growth").length;
  const insufficientCount = forecasts.filter((forecast) => forecast.state === "insufficient").length;

  return {
    generatedAt: new Date().toISOString(),
    range,
    sources: {
      monitoring: monitoringResult.status === "fulfilled",
      hostHistory: hostHistoryResult.status === "fulfilled",
      containerHistory: containerHistoryResult.status === "fulfilled",
      backups: backupResult.status === "fulfilled",
    },
    hostResources,
    containerResources,
    backupGrowth,
    hostHistory,
    containerHistory,
    summary: {
      forecastAttentionCount: criticalCount + warningCount,
      criticalCount,
      warningCount,
      growthCount,
      insufficientCount,
      backupGrowthCount: backupGrowth.filter((item) => item.state === "growth").length,
    },
  };
}
