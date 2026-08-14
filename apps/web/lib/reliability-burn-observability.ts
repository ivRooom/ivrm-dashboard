import "server-only";

import { RELIABILITY_SLO_SERVICE_IDS, isReliabilitySloServiceId } from "./reliability-maintenance-validation";
import type {
  ReliabilityBurnRateHistory,
  ReliabilityBurnRateHistoryPoint,
  ReliabilityBurnRateService,
  ReliabilityBurnRateState,
  ReliabilityBurnReconcilerHealth,
  ReliabilityBurnReconcilerState,
  ReliabilityBurnWindowId,
  ReliabilityRange,
} from "./reliability-types";
import { INCIDENT_RANGE_CONFIG } from "./unified-incidents";

const HISTORY_BUCKET_MINUTES: Record<ReliabilityRange, 5 | 30 | 120> = {
  "24h": 5,
  "7d": 30,
  "30d": 120,
};

const BURN_STATES: readonly ReliabilityBurnRateState[] = [
  "unconfigured",
  "healthy",
  "warning",
  "critical",
  "coverage_unknown",
  "data_unavailable",
];

const HEALTH_DEGRADED_AFTER_MS = 120_000;
const HEALTH_CRITICAL_AFTER_MS = 180_000;

type ReconcilerStateRow = {
  enabled: unknown;
  endpoint_configured: unknown;
  state_updated_at: unknown;
  last_invoked_at: unknown;
  last_success_at: unknown;
  last_error_at: unknown;
  last_error_code: unknown;
  last_evaluated_count: unknown;
};

type HistoryRow = {
  service_id: unknown;
  bucket_started_at: unknown;
  observed_at: unknown;
  state: unknown;
  target_percent: unknown;
  burn_rate_1h: unknown;
  burn_rate_6h: unknown;
  burn_rate_24h: unknown;
  exact_1h: unknown;
  exact_6h: unknown;
  exact_24h: unknown;
};

function configuration(): { url: string; serviceRoleKey: string } {
  const rawUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!rawUrl || !serviceRoleKey) {
    throw new Error("Burn Rate観測のSupabase設定が不足しています");
  }
  return { url: rawUrl.replace(/\/$/, ""), serviceRoleKey };
}

async function callRpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const { url, serviceRoleKey } = configuration();
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(7_500),
  });
  if (!response.ok) {
    throw new Error(`Burn Rate観測RPC ${name} が${response.status}を返しました`);
  }
  return response.json();
}

function parseTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function parseNullableTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  return parseTimestamp(value) ?? undefined;
}

function parseNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function isBurnState(value: unknown): value is ReliabilityBurnRateState {
  return typeof value === "string" && (BURN_STATES as readonly string[]).includes(value);
}

function reconcilerHealth(input: {
  enabled: boolean;
  endpointConfigured: boolean;
  stateUpdatedAt: string;
  lastInvokedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  referenceAt: string;
}): { health: ReliabilityBurnReconcilerHealth; reason: string } {
  if (!input.enabled) {
    return { health: "disabled", reason: "Burn Reconcilerは停止しています。" };
  }
  if (!input.endpointConfigured) {
    return { health: "critical", reason: "Reconciler Endpointが設定されていません。" };
  }

  const referenceMs = Date.parse(input.referenceAt);
  const stateUpdatedMs = Date.parse(input.stateUpdatedAt);
  if (!Number.isFinite(referenceMs) || !Number.isFinite(stateUpdatedMs)) {
    return { health: "unknown", reason: "Reconcilerの基準時刻を判定できません。" };
  }

  const successMs = input.lastSuccessAt ? Date.parse(input.lastSuccessAt) : Number.NaN;
  const invokedMs = input.lastInvokedAt ? Date.parse(input.lastInvokedAt) : Number.NaN;
  const errorMs = input.lastErrorAt ? Date.parse(input.lastErrorAt) : Number.NaN;

  if (Number.isFinite(errorMs) && (!Number.isFinite(successMs) || errorMs > successMs)) {
    return { health: "critical", reason: "最新のReconcileが失敗しています。" };
  }
  if (!Number.isFinite(invokedMs)) {
    const startupAge = Math.max(0, referenceMs - stateUpdatedMs);
    return startupAge > HEALTH_CRITICAL_AFTER_MS
      ? { health: "critical", reason: "Reconciler有効化後3分以上、一度もCron起動を確認できません。" }
      : { health: "degraded", reason: "Reconcilerの初回実行を待っています。" };
  }
  if (!Number.isFinite(successMs)) {
    const invokedAge = Math.max(0, referenceMs - invokedMs);
    return invokedAge > HEALTH_CRITICAL_AFTER_MS
      ? { health: "critical", reason: "Reconcilerの成功実績が確認できません。" }
      : { health: "degraded", reason: "Reconcilerの初回成功を待っています。" };
  }

  const successAge = Math.max(0, referenceMs - successMs);
  if (successAge > HEALTH_CRITICAL_AFTER_MS) {
    return { health: "critical", reason: "最終成功から3分以上経過しています。" };
  }
  if (successAge > HEALTH_DEGRADED_AFTER_MS) {
    return { health: "degraded", reason: "最終成功から2分以上経過しています。" };
  }

  const invokedAge = Math.max(0, referenceMs - invokedMs);
  if (invokedAge > HEALTH_DEGRADED_AFTER_MS) {
    return { health: "degraded", reason: "Cronの最新起動が遅延しています。" };
  }
  return { health: "operational", reason: "1分Reconcilerは正常に実行されています。" };
}

export function unavailableReliabilityBurnReconcilerState(): ReliabilityBurnReconcilerState {
  return {
    dataAvailable: false,
    health: "unknown",
    reason: "Reconciler状態を取得できません。",
    enabled: null,
    endpointConfigured: null,
    lastInvokedAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    lastEvaluatedCount: null,
  };
}

export async function getReliabilityBurnReconcilerState(
  referenceAt: string,
): Promise<ReliabilityBurnReconcilerState> {
  const payload = await callRpc("get_reliability_burn_reconcile_state_v2", {});
  if (!Array.isArray(payload) || payload.length !== 1) {
    throw new Error("Burn Reconciler状態レスポンスが不正です");
  }
  const raw = payload[0];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Burn Reconciler状態行が不正です");
  }
  const row = raw as ReconcilerStateRow;
  const stateUpdatedAt = parseTimestamp(row.state_updated_at);
  const lastInvokedAt = parseNullableTimestamp(row.last_invoked_at);
  const lastSuccessAt = parseNullableTimestamp(row.last_success_at);
  const lastErrorAt = parseNullableTimestamp(row.last_error_at);
  const lastEvaluatedCount = parseInteger(row.last_evaluated_count);
  if (
    typeof row.enabled !== "boolean" ||
    typeof row.endpoint_configured !== "boolean" ||
    !stateUpdatedAt ||
    lastInvokedAt === undefined ||
    lastSuccessAt === undefined ||
    lastErrorAt === undefined ||
    (row.last_error_code !== null && typeof row.last_error_code !== "string") ||
    lastEvaluatedCount === undefined ||
    lastEvaluatedCount < 0 ||
    lastEvaluatedCount > 4
  ) {
    throw new Error("Burn Reconciler状態形式が不正です");
  }

  const health = reconcilerHealth({
    enabled: row.enabled,
    endpointConfigured: row.endpoint_configured,
    stateUpdatedAt,
    lastInvokedAt,
    lastSuccessAt,
    lastErrorAt,
    referenceAt,
  });
  return {
    dataAvailable: true,
    health: health.health,
    reason: health.reason,
    enabled: row.enabled,
    endpointConfigured: row.endpoint_configured,
    lastInvokedAt,
    lastSuccessAt,
    lastErrorAt,
    lastErrorCode: row.last_error_code as string | null,
    lastEvaluatedCount,
  };
}

function parseHistoryPoint(raw: unknown): ReliabilityBurnRateHistoryPoint {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Burn Rate履歴行が不正です");
  }
  const row = raw as HistoryRow;
  const bucketStartedAt = parseTimestamp(row.bucket_started_at);
  const observedAt = parseTimestamp(row.observed_at);
  const targetPercent = parseNumber(row.target_percent);
  const burnRate1h = parseNumber(row.burn_rate_1h);
  const burnRate6h = parseNumber(row.burn_rate_6h);
  const burnRate24h = parseNumber(row.burn_rate_24h);
  if (
    !isReliabilitySloServiceId(row.service_id) ||
    !bucketStartedAt ||
    !observedAt ||
    !isBurnState(row.state) ||
    targetPercent === undefined ||
    burnRate1h === undefined ||
    burnRate6h === undefined ||
    burnRate24h === undefined ||
    typeof row.exact_1h !== "boolean" ||
    typeof row.exact_6h !== "boolean" ||
    typeof row.exact_24h !== "boolean"
  ) {
    throw new Error("Burn Rate履歴レスポンス形式が不正です");
  }
  return {
    serviceId: row.service_id,
    bucketStartedAt,
    observedAt,
    state: row.state,
    targetPercent,
    burnRate1h,
    burnRate6h,
    burnRate24h,
    exact1h: row.exact_1h,
    exact6h: row.exact_6h,
    exact24h: row.exact_24h,
  };
}

export function unavailableReliabilityBurnRateHistory(
  range: ReliabilityRange,
): ReliabilityBurnRateHistory {
  return {
    dataAvailable: false,
    bucketMinutes: HISTORY_BUCKET_MINUTES[range],
    points: [],
  };
}

export async function getReliabilityBurnRateHistory(
  range: ReliabilityRange,
  referenceAt: string,
): Promise<ReliabilityBurnRateHistory> {
  const referenceMs = Date.parse(referenceAt);
  if (!Number.isFinite(referenceMs)) {
    throw new Error("Burn Rate履歴の基準時刻が不正です");
  }
  const since = new Date(
    referenceMs - INCIDENT_RANGE_CONFIG[range].hours * 3_600_000,
  ).toISOString();
  const bucketMinutes = HISTORY_BUCKET_MINUTES[range];
  const payload = await callRpc("list_reliability_burn_rate_history_v1", {
    p_since: since,
    p_bucket_minutes: bucketMinutes,
  });
  if (!Array.isArray(payload)) {
    throw new Error("Burn Rate履歴レスポンスが配列ではありません");
  }
  return {
    dataAvailable: true,
    bucketMinutes,
    points: payload.map(parseHistoryPoint),
  };
}

function windowFor(service: ReliabilityBurnRateService, id: ReliabilityBurnWindowId) {
  return service.windows.find((window) => window.windowId === id) ?? null;
}

function sampleFor(service: ReliabilityBurnRateService): Record<string, unknown> {
  const oneHour = windowFor(service, "1h");
  const sixHours = windowFor(service, "6h");
  const twentyFourHours = windowFor(service, "24h");
  return {
    service_id: service.serviceId,
    state: service.state,
    target_percent: service.targetPercent,
    burn_rate_1h: oneHour?.burnRate ?? null,
    burn_rate_6h: sixHours?.burnRate ?? null,
    burn_rate_24h: twentyFourHours?.burnRate ?? null,
    exact_1h: oneHour?.exactCoverage ?? false,
    exact_6h: sixHours?.exactCoverage ?? false,
    exact_24h: twentyFourHours?.exactCoverage ?? false,
    counted_downtime_1h: oneHour?.countedDowntimeSeconds ?? null,
    counted_downtime_6h: sixHours?.countedDowntimeSeconds ?? null,
    counted_downtime_24h: twentyFourHours?.countedDowntimeSeconds ?? null,
    maintenance_excluded_1h: oneHour?.maintenanceExcludedSeconds ?? null,
    maintenance_excluded_6h: sixHours?.maintenanceExcludedSeconds ?? null,
    maintenance_excluded_24h: twentyFourHours?.maintenanceExcludedSeconds ?? null,
  };
}

export async function recordReliabilityBurnRateHistory(input: {
  generatedAt: string;
  burnRates: ReliabilityBurnRateService[];
}): Promise<void> {
  const byService = new Map(input.burnRates.map((service) => [service.serviceId, service]));
  const ordered = RELIABILITY_SLO_SERVICE_IDS.map((serviceId) => byService.get(serviceId));
  if (ordered.some((service) => !service)) {
    throw new Error("Burn Rate履歴へ保存する4サービスが揃っていません");
  }
  const result = await callRpc("record_reliability_burn_rate_samples_v1", {
    p_observed_at: input.generatedAt,
    p_samples: ordered.map((service) => sampleFor(service as ReliabilityBurnRateService)),
  });
  if (Number(result) !== 4) {
    throw new Error("Burn Rate履歴の保存件数が不正です");
  }
}