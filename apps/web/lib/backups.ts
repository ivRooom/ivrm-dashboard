import type {
  BackupDestination,
  BackupFailureCode,
  BackupOutcome,
  BackupType,
} from "./backup-report";

export const BACKUP_RANGE_CONFIG = {
  "24h": { label: "24時間", hours: 24, refreshMs: 30_000 },
  "7d": { label: "7日", hours: 24 * 7, refreshMs: 60_000 },
  "30d": { label: "30日", hours: 24 * 30, refreshMs: 120_000 },
} as const;

export type BackupRange = keyof typeof BACKUP_RANGE_CONFIG;
export type BackupHealth = "healthy" | "warning" | "critical" | "unknown";
export type RestoreReadiness = "ready" | "warning" | "unknown";

export type BackupTargetSnapshot = {
  policyId: number;
  hostId: string;
  serverId: string;
  hostDisplayName: string;
  backupTarget: string;
  gameMode: string;
  backupType: BackupType;
  remoteSyncRequired: boolean;
  warningAfterSeconds: number;
  criticalAfterSeconds: number;
  remoteSyncWarningSeconds: number;
  restoreTestWarningSeconds: number;
  latest: BackupRunSummary | null;
  latestSuccess: BackupSuccessSummary | null;
  health: BackupHealth;
  healthReasons: string[];
  backupAgeSeconds: number | null;
  remoteSyncPending: boolean;
  restoreReadiness: RestoreReadiness;
};

export type BackupRunSummary = {
  runId: string;
  outcome: BackupOutcome;
  startedAt: string;
  completedAt: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  sha256Verified: boolean | null;
  destinationType: BackupDestination;
  remoteSyncedAt: string | null;
  restoreTestedAt: string | null;
  retentionExpiresAt: string | null;
  failureCode: BackupFailureCode | null;
};

export type BackupSuccessSummary = {
  runId: string;
  completedAt: string;
  sizeBytes: number | null;
  sha256Verified: boolean | null;
  destinationType: BackupDestination;
  remoteSyncedAt: string | null;
  restoreTestedAt: string | null;
  retentionExpiresAt: string | null;
};

export type BackupHistoryRun = BackupRunSummary & {
  rowId: number;
  hostId: string;
  serverId: string;
  hostDisplayName: string;
  backupTarget: string;
  gameMode: string;
  backupType: BackupType;
};

export type BackupCenterSnapshot = {
  generatedAt: string;
  range: BackupRange;
  targets: BackupTargetSnapshot[];
  history: BackupHistoryRun[];
  summary: {
    overallHealth: BackupHealth;
    targetCount: number;
    healthyCount: number;
    warningCount: number;
    criticalCount: number;
    unknownCount: number;
    latestSuccessAt: string | null;
    latestFailureAt: string | null;
    successRatePercent: number | null;
    completedRunCount: number;
    successRunCount: number;
    remoteSyncPendingCount: number;
    restoreReadyCount: number;
  };
};

type CenterRow = Record<string, unknown>;
type HistoryRow = Record<string, unknown>;

const RANGES = new Set<BackupRange>(["24h", "7d", "30d"]);
const BACKUP_TYPES = new Set<BackupType>(["world", "config", "permissions", "full"]);
const DESTINATIONS = new Set<BackupDestination>(["local", "s3"]);
const OUTCOMES = new Set<BackupOutcome>(["success", "failed", "running", "unknown"]);
const FAILURE_CODES = new Set<BackupFailureCode>([
  "source_unavailable",
  "archive_failed",
  "checksum_failed",
  "remote_sync_failed",
  "retention_failed",
  "timeout",
  "permission_denied",
  "insufficient_space",
  "unknown",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HISTORY_PAGE_SIZE = 500;
const MAX_HISTORY_PAGES = 1_000;

export function parseBackupRange(value: string | null | undefined): BackupRange {
  return value && RANGES.has(value as BackupRange) ? (value as BackupRange) : "24h";
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}が設定されていません`);
  return value;
}

function supabaseConfiguration(): { url: string; serviceRoleKey: string } {
  return {
    url: requireEnvironment("SUPABASE_URL").replace(/\/$/, ""),
    serviceRoleKey: requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

async function callRpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const { url, serviceRoleKey } = supabaseConfiguration();
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
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${name}が${response.status}を返しました`);
  return response.json();
}

function text(value: unknown, maximum = 256): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function nullableTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  const parsed = timestamp(value);
  return parsed ?? undefined;
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function nullableInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  const parsed = integer(value);
  return parsed === null ? undefined : parsed;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nullableBool(value: unknown): boolean | null | undefined {
  return value === null ? null : typeof value === "boolean" ? value : undefined;
}

function parseLatest(row: CenterRow): BackupRunSummary | null | undefined {
  if (row.latest_run_id === null) return null;
  const runId = text(row.latest_run_id, 36);
  const outcome = text(row.latest_outcome) as BackupOutcome | null;
  const startedAt = timestamp(row.latest_started_at);
  const completedAt = nullableTimestamp(row.latest_completed_at);
  const durationSeconds = nullableInteger(row.latest_duration_seconds);
  const sizeBytes = nullableInteger(row.latest_size_bytes);
  const sha256Verified = nullableBool(row.latest_sha256_verified);
  const destinationType = text(row.latest_destination_type) as BackupDestination | null;
  const remoteSyncedAt = nullableTimestamp(row.latest_remote_synced_at);
  const restoreTestedAt = nullableTimestamp(row.latest_restore_tested_at);
  const retentionExpiresAt = nullableTimestamp(row.latest_retention_expires_at);
  const failureCode = row.latest_failure_code === null
    ? null
    : (text(row.latest_failure_code) as BackupFailureCode | null);
  if (
    !runId || !UUID_PATTERN.test(runId) || !outcome || !OUTCOMES.has(outcome) || !startedAt ||
    completedAt === undefined || durationSeconds === undefined || sizeBytes === undefined ||
    sha256Verified === undefined || !destinationType || !DESTINATIONS.has(destinationType) ||
    remoteSyncedAt === undefined || restoreTestedAt === undefined || retentionExpiresAt === undefined ||
    (failureCode !== null && !FAILURE_CODES.has(failureCode))
  ) return undefined;
  return {
    runId, outcome, startedAt, completedAt, durationSeconds, sizeBytes, sha256Verified,
    destinationType, remoteSyncedAt, restoreTestedAt, retentionExpiresAt, failureCode,
  };
}

function parseLatestSuccess(row: CenterRow): BackupSuccessSummary | null | undefined {
  if (row.latest_success_run_id === null) return null;
  const runId = text(row.latest_success_run_id, 36);
  const completedAt = timestamp(row.latest_success_at);
  const sizeBytes = nullableInteger(row.latest_success_size_bytes);
  const sha256Verified = nullableBool(row.latest_success_sha256_verified);
  const destinationType = text(row.latest_success_destination_type) as BackupDestination | null;
  const remoteSyncedAt = nullableTimestamp(row.latest_success_remote_synced_at);
  const restoreTestedAt = nullableTimestamp(row.latest_success_restore_tested_at);
  const retentionExpiresAt = nullableTimestamp(row.latest_success_retention_expires_at);
  if (
    !runId || !UUID_PATTERN.test(runId) || !completedAt || sizeBytes === undefined ||
    sha256Verified === undefined || !destinationType || !DESTINATIONS.has(destinationType) ||
    remoteSyncedAt === undefined || restoreTestedAt === undefined || retentionExpiresAt === undefined
  ) return undefined;
  return {
    runId, completedAt, sizeBytes, sha256Verified, destinationType,
    remoteSyncedAt, restoreTestedAt, retentionExpiresAt,
  };
}

function parseCenterRows(payload: unknown): Omit<BackupTargetSnapshot, "health" | "healthReasons" | "backupAgeSeconds" | "remoteSyncPending" | "restoreReadiness">[] {
  if (!Array.isArray(payload)) throw new Error("Backup Centerレスポンスが配列ではありません");
  return payload.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Backup Center行が不正です");
    const row = value as CenterRow;
    const policyId = integer(row.policy_id);
    const hostId = text(row.host_id, 36);
    const serverId = text(row.server_id, 64);
    const hostDisplayName = text(row.host_display_name);
    const backupTarget = text(row.backup_target, 64);
    const gameMode = text(row.game_mode, 64);
    const backupType = text(row.backup_type) as BackupType | null;
    const remoteSyncRequired = bool(row.remote_sync_required);
    const warningAfterSeconds = integer(row.warning_after_seconds);
    const criticalAfterSeconds = integer(row.critical_after_seconds);
    const remoteSyncWarningSeconds = integer(row.remote_sync_warning_seconds);
    const restoreTestWarningSeconds = integer(row.restore_test_warning_seconds);
    const latest = parseLatest(row);
    const latestSuccess = parseLatestSuccess(row);
    if (
      policyId === null || policyId < 1 || !hostId || !UUID_PATTERN.test(hostId) || !serverId ||
      !hostDisplayName || !backupTarget || !gameMode || !backupType || !BACKUP_TYPES.has(backupType) ||
      remoteSyncRequired === null || warningAfterSeconds === null || criticalAfterSeconds === null ||
      remoteSyncWarningSeconds === null || restoreTestWarningSeconds === null ||
      latest === undefined || latestSuccess === undefined
    ) throw new Error("Backup Centerレスポンス形式が不正です");
    return {
      policyId, hostId, serverId, hostDisplayName, backupTarget, gameMode, backupType,
      remoteSyncRequired, warningAfterSeconds, criticalAfterSeconds,
      remoteSyncWarningSeconds, restoreTestWarningSeconds, latest, latestSuccess,
    };
  });
}

function parseHistoryRows(payload: unknown): BackupHistoryRun[] {
  if (!Array.isArray(payload)) throw new Error("Backup履歴レスポンスが配列ではありません");
  return payload.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Backup履歴行が不正です");
    const row = value as HistoryRow;
    const rowId = integer(row.row_id);
    const runId = text(row.run_id, 36);
    const hostId = text(row.host_id, 36);
    const serverId = text(row.server_id, 64);
    const hostDisplayName = text(row.host_display_name);
    const backupTarget = text(row.backup_target, 64);
    const gameMode = text(row.game_mode, 64);
    const backupType = text(row.backup_type) as BackupType | null;
    const destinationType = text(row.destination_type) as BackupDestination | null;
    const startedAt = timestamp(row.started_at);
    const completedAt = nullableTimestamp(row.completed_at);
    const outcome = text(row.outcome) as BackupOutcome | null;
    const durationSeconds = nullableInteger(row.duration_seconds);
    const sizeBytes = nullableInteger(row.size_bytes);
    const sha256Verified = nullableBool(row.sha256_verified);
    const remoteSyncedAt = nullableTimestamp(row.remote_synced_at);
    const restoreTestedAt = nullableTimestamp(row.restore_tested_at);
    const retentionExpiresAt = nullableTimestamp(row.retention_expires_at);
    const failureCode = row.failure_code === null ? null : (text(row.failure_code) as BackupFailureCode | null);
    if (
      rowId === null || rowId < 1 || !runId || !UUID_PATTERN.test(runId) || !hostId || !UUID_PATTERN.test(hostId) ||
      !serverId || !hostDisplayName || !backupTarget || !gameMode || !backupType || !BACKUP_TYPES.has(backupType) ||
      !destinationType || !DESTINATIONS.has(destinationType) || !startedAt || completedAt === undefined ||
      !outcome || !OUTCOMES.has(outcome) || durationSeconds === undefined || sizeBytes === undefined ||
      sha256Verified === undefined || remoteSyncedAt === undefined || restoreTestedAt === undefined ||
      retentionExpiresAt === undefined || (failureCode !== null && !FAILURE_CODES.has(failureCode))
    ) throw new Error("Backup履歴レスポンス形式が不正です");
    return {
      rowId, runId, hostId, serverId, hostDisplayName, backupTarget, gameMode, backupType,
      destinationType, startedAt, completedAt, outcome, durationSeconds, sizeBytes,
      sha256Verified, remoteSyncedAt, restoreTestedAt, retentionExpiresAt, failureCode,
    };
  });
}

async function getAllBackupHistory(range: BackupRange): Promise<BackupHistoryRun[]> {
  const history: BackupHistoryRun[] = [];
  let beforeStartedAt: string | null = null;
  let beforeId: number | null = null;

  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const payload = await callRpc("get_backup_runs_v2", {
      p_range: range,
      p_limit: HISTORY_PAGE_SIZE,
      p_before_started_at: beforeStartedAt,
      p_before_id: beforeId,
    });
    const rows = parseHistoryRows(payload);
    history.push(...rows);
    if (rows.length < HISTORY_PAGE_SIZE) return history;

    const last = rows.at(-1);
    if (!last) return history;
    beforeStartedAt = last.startedAt;
    beforeId = last.rowId;
  }

  throw new Error("Backup履歴がページ上限を超えました");
}

function healthRank(health: BackupHealth): number {
  return { healthy: 0, unknown: 1, warning: 2, critical: 3 }[health];
}

function evaluateTarget(
  target: Omit<BackupTargetSnapshot, "health" | "healthReasons" | "backupAgeSeconds" | "remoteSyncPending" | "restoreReadiness">,
  nowMs: number,
): BackupTargetSnapshot {
  const reasons: string[] = [];
  const success = target.latestSuccess;
  const latest = target.latest;
  const backupAgeSeconds = success
    ? Math.max(0, Math.floor((nowMs - Date.parse(success.completedAt)) / 1_000))
    : null;
  let health: BackupHealth = success ? "healthy" : "unknown";

  if (latest?.outcome === "failed") {
    health = "critical";
    reasons.push(`最新バックアップ失敗: ${latest.failureCode ?? "unknown"}`);
  }
  if (!success) {
    reasons.push("成功済みバックアップをまだ確認できません");
  } else {
    if (backupAgeSeconds !== null && backupAgeSeconds > target.criticalAfterSeconds) {
      health = "critical";
      reasons.push("最新成功がCritical SLAを超過しています");
    } else if (backupAgeSeconds !== null && backupAgeSeconds > target.warningAfterSeconds && health !== "critical") {
      health = "warning";
      reasons.push("最新成功がWarning SLAを超過しています");
    }

    if (success.sha256Verified === false) {
      health = "critical";
      reasons.push("SHA-256検証失敗を確認しました");
    } else if (success.sha256Verified === null && health !== "critical") {
      health = "warning";
      reasons.push("SHA-256検証結果が未取得です");
    }

    if (success.retentionExpiresAt && Date.parse(success.retentionExpiresAt) <= nowMs) {
      health = "critical";
      reasons.push("最新成功バックアップのRetention期限を超過しています");
    }

    if ((latest?.outcome === "running" || latest?.outcome === "unknown") && health === "healthy") {
      health = "warning";
      reasons.push("最新Runの結果がまだ確定していません");
    }
  }

  const remoteSyncPending = Boolean(success && target.remoteSyncRequired && !success.remoteSyncedAt);
  if (
    remoteSyncPending && success &&
    nowMs - Date.parse(success.completedAt) > target.remoteSyncWarningSeconds * 1_000 &&
    health !== "critical"
  ) {
    health = "warning";
    reasons.push("Remote SyncがSLA内に完了していません");
  }

  let restoreReadiness: RestoreReadiness = "unknown";
  if (success) {
    const retentionValid = success.retentionExpiresAt
      ? Date.parse(success.retentionExpiresAt) > nowMs
      : false;
    const restoreFresh = success.restoreTestedAt
      ? nowMs - Date.parse(success.restoreTestedAt) <= target.restoreTestWarningSeconds * 1_000
      : false;
    if (success.sha256Verified === true && retentionValid && restoreFresh) {
      restoreReadiness = "ready";
    } else if (
      success.restoreTestedAt === null &&
      backupAgeSeconds !== null &&
      backupAgeSeconds > target.restoreTestWarningSeconds &&
      health !== "critical"
    ) {
      restoreReadiness = "warning";
      health = "warning";
      reasons.push("Restore Testが長期間実施されていません");
    }
  }

  if (health === "healthy" && reasons.length === 0) reasons.push("最新成功・整合性・SLAに異常はありません");
  return { ...target, health, healthReasons: reasons, backupAgeSeconds, remoteSyncPending, restoreReadiness };
}

export async function getBackupCenterSnapshot(range: BackupRange): Promise<BackupCenterSnapshot> {
  const [centerPayload, history] = await Promise.all([
    callRpc("get_backup_center_v1", {}),
    getAllBackupHistory(range),
  ]);
  const generatedAt = new Date().toISOString();
  const nowMs = Date.parse(generatedAt);
  const targets = parseCenterRows(centerPayload).map((target) => evaluateTarget(target, nowMs));
  const completed = history.filter((run) => run.outcome === "success" || run.outcome === "failed");
  const successes = completed.filter((run) => run.outcome === "success");
  const failures = completed.filter((run) => run.outcome === "failed" && run.completedAt);
  const latestSuccessAt = targets
    .map((target) => target.latestSuccess?.completedAt ?? null)
    .filter((value): value is string => value !== null)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const latestFailureAt = failures
    .map((run) => run.completedAt)
    .filter((value): value is string => value !== null)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const counts = { healthy: 0, warning: 0, critical: 0, unknown: 0 };
  for (const target of targets) counts[target.health] += 1;
  const overallHealth = targets.length === 0
    ? "unknown"
    : targets.reduce<BackupHealth>((worst, target) =>
        healthRank(target.health) > healthRank(worst) ? target.health : worst,
      "healthy");

  return {
    generatedAt,
    range,
    targets,
    history,
    summary: {
      overallHealth,
      targetCount: targets.length,
      healthyCount: counts.healthy,
      warningCount: counts.warning,
      criticalCount: counts.critical,
      unknownCount: counts.unknown,
      latestSuccessAt,
      latestFailureAt,
      successRatePercent: completed.length > 0 ? (successes.length / completed.length) * 100 : null,
      completedRunCount: completed.length,
      successRunCount: successes.length,
      remoteSyncPendingCount: targets.filter((target) => target.remoteSyncPending).length,
      restoreReadyCount: targets.filter((target) => target.restoreReadiness === "ready").length,
    },
  };
}
