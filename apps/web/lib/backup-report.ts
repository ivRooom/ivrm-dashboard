import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_RUNS = 20;
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60;
const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MAX_BACKUP_REPORT_BODY_BYTES = 32 * 1024;

export const BACKUP_TYPES = ["world", "config", "permissions", "full"] as const;
export const BACKUP_DESTINATIONS = ["local", "s3"] as const;
export const BACKUP_OUTCOMES = ["success", "failed", "running", "unknown"] as const;
export const BACKUP_FAILURE_CODES = [
  "source_unavailable",
  "archive_failed",
  "checksum_failed",
  "remote_sync_failed",
  "retention_failed",
  "timeout",
  "permission_denied",
  "insufficient_space",
  "unknown",
] as const;

export type BackupType = (typeof BACKUP_TYPES)[number];
export type BackupDestination = (typeof BACKUP_DESTINATIONS)[number];
export type BackupOutcome = (typeof BACKUP_OUTCOMES)[number];
export type BackupFailureCode = (typeof BACKUP_FAILURE_CODES)[number];

export type BackupRunReport = {
  runId: string;
  backupTarget: string;
  gameMode: string;
  backupType: BackupType;
  destinationType: BackupDestination;
  startedAt: string;
  completedAt: string | null;
  outcome: BackupOutcome;
  durationSeconds: number | null;
  sizeBytes: number | null;
  sha256Verified: boolean | null;
  remoteSyncedAt: string | null;
  restoreTestedAt: string | null;
  retentionExpiresAt: string | null;
  failureCode: BackupFailureCode | null;
};

export type BackupReportPayload = {
  serverId: string;
  reportedAt: string;
  runs: BackupRunReport[];
};

type PersistResult =
  | "accepted"
  | "unknown_agent"
  | "rate_limited"
  | "replayed_request"
  | "invalid_payload";

const backupTypes = new Set<string>(BACKUP_TYPES);
const backupDestinations = new Set<string>(BACKUP_DESTINATIONS);
const backupOutcomes = new Set<string>(BACKUP_OUTCOMES);
const backupFailureCodes = new Set<string>(BACKUP_FAILURE_CODES);
const REPORT_KEYS = new Set(["serverId", "reportedAt", "runs"]);
const RUN_KEYS = new Set([
  "runId",
  "backupTarget",
  "gameMode",
  "backupType",
  "destinationType",
  "startedAt",
  "completedAt",
  "outcome",
  "durationSeconds",
  "sizeBytes",
  "sha256Verified",
  "remoteSyncedAt",
  "restoreTestedAt",
  "retentionExpiresAt",
  "failureCode",
]);

export class BackupReportError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function nullableTimestamp(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

function requiredTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function nullableSafeInteger(value: unknown, maximum = MAX_SAFE_BYTES): number | null | undefined {
  if (value === null || value === undefined) return null;
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum
    ? Number(value)
    : undefined;
}

function normalizeRun(value: unknown, reportedAt: string): BackupRunReport | null {
  if (!isRecord(value) || !hasOnlyKeys(value, RUN_KEYS)) return null;

  const startedAt = requiredTimestamp(value.startedAt);
  const completedAt = nullableTimestamp(value.completedAt);
  const remoteSyncedAt = nullableTimestamp(value.remoteSyncedAt);
  const restoreTestedAt = nullableTimestamp(value.restoreTestedAt);
  const retentionExpiresAt = nullableTimestamp(value.retentionExpiresAt);
  const durationSeconds = nullableSafeInteger(value.durationSeconds, MAX_DURATION_SECONDS);
  const sizeBytes = nullableSafeInteger(value.sizeBytes);

  if (
    typeof value.runId !== "string" || !UUID_PATTERN.test(value.runId) ||
    typeof value.backupTarget !== "string" || !IDENTIFIER_PATTERN.test(value.backupTarget) ||
    typeof value.gameMode !== "string" || !IDENTIFIER_PATTERN.test(value.gameMode) ||
    typeof value.backupType !== "string" || !backupTypes.has(value.backupType) ||
    typeof value.destinationType !== "string" || !backupDestinations.has(value.destinationType) ||
    !startedAt || completedAt === undefined || remoteSyncedAt === undefined ||
    restoreTestedAt === undefined || retentionExpiresAt === undefined ||
    durationSeconds === undefined || sizeBytes === undefined ||
    typeof value.outcome !== "string" || !backupOutcomes.has(value.outcome) ||
    (value.sha256Verified !== null && value.sha256Verified !== undefined && typeof value.sha256Verified !== "boolean") ||
    (value.failureCode !== null && value.failureCode !== undefined &&
      (typeof value.failureCode !== "string" || !backupFailureCodes.has(value.failureCode)))
  ) {
    return null;
  }

  const reportTime = Date.parse(reportedAt);
  const startedTime = Date.parse(startedAt);
  const completedTime = completedAt ? Date.parse(completedAt) : null;
  const remoteTime = remoteSyncedAt ? Date.parse(remoteSyncedAt) : null;
  const restoreTime = restoreTestedAt ? Date.parse(restoreTestedAt) : null;
  const retentionTime = retentionExpiresAt ? Date.parse(retentionExpiresAt) : null;
  const outcome = value.outcome as BackupOutcome;
  const failureCode = (value.failureCode ?? null) as BackupFailureCode | null;

  if (
    startedTime > reportTime + MAX_CLOCK_SKEW_SECONDS * 1_000 ||
    startedTime < reportTime - 90 * 24 * 60 * 60 * 1_000 ||
    ((outcome === "success" || outcome === "failed") && (completedTime === null || durationSeconds === null)) ||
    ((outcome === "running" || outcome === "unknown") && (completedTime !== null || durationSeconds !== null)) ||
    (completedTime !== null && (completedTime < startedTime || completedTime > reportTime + MAX_CLOCK_SKEW_SECONDS * 1_000)) ||
    (outcome === "failed" && failureCode === null) ||
    (outcome !== "failed" && failureCode !== null) ||
    (remoteTime !== null && (completedTime === null || remoteTime < completedTime || remoteTime > reportTime + MAX_CLOCK_SKEW_SECONDS * 1_000)) ||
    (restoreTime !== null && (completedTime === null || restoreTime < completedTime || restoreTime > reportTime + MAX_CLOCK_SKEW_SECONDS * 1_000)) ||
    (retentionTime !== null && (completedTime === null || retentionTime <= completedTime))
  ) {
    return null;
  }

  return {
    runId: value.runId,
    backupTarget: value.backupTarget,
    gameMode: value.gameMode,
    backupType: value.backupType as BackupType,
    destinationType: value.destinationType as BackupDestination,
    startedAt,
    completedAt,
    outcome,
    durationSeconds,
    sizeBytes,
    sha256Verified: (value.sha256Verified ?? null) as boolean | null,
    remoteSyncedAt,
    restoreTestedAt,
    retentionExpiresAt,
    failureCode,
  };
}

export function parseBackupReport(rawBody: Uint8Array): BackupReportPayload {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    throw new BackupReportError(400, "invalid_json");
  }

  if (!isRecord(value) || !hasOnlyKeys(value, REPORT_KEYS)) {
    throw new BackupReportError(400, "invalid_payload");
  }
  if (
    typeof value.serverId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value.serverId) ||
    typeof value.reportedAt !== "string" || !Number.isFinite(Date.parse(value.reportedAt)) ||
    !Array.isArray(value.runs) || value.runs.length < 1 || value.runs.length > MAX_RUNS
  ) {
    throw new BackupReportError(400, "invalid_payload");
  }

  const reportedAtMs = Date.parse(value.reportedAt);
  if (Math.abs(Date.now() - reportedAtMs) > MAX_CLOCK_SKEW_SECONDS * 1_000) {
    throw new BackupReportError(401, "expired_request");
  }

  const runs = value.runs.map((item) => normalizeRun(item, value.reportedAt));
  if (runs.some((run) => run === null)) {
    throw new BackupReportError(400, "invalid_payload");
  }

  const seen = new Set<string>();
  for (const run of runs as BackupRunReport[]) {
    if (seen.has(run.runId)) {
      throw new BackupReportError(400, "duplicate_run_id");
    }
    seen.add(run.runId);
  }

  return {
    serverId: value.serverId,
    reportedAt: value.reportedAt,
    runs: runs as BackupRunReport[],
  };
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new BackupReportError(503, "service_not_configured");
  return value;
}

function readAgentSecrets(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(requireEnvironment("IVRM_AGENT_SECRETS_JSON"));
    if (!isRecord(parsed)) throw new Error("invalid map");
    const secrets: Record<string, string> = {};
    for (const [serverId, secret] of Object.entries(parsed)) {
      if (typeof secret !== "string" || secret.length < 32) throw new Error("invalid secret");
      secrets[serverId] = secret;
    }
    return secrets;
  } catch (error) {
    if (error instanceof BackupReportError) throw error;
    throw new BackupReportError(503, "service_not_configured");
  }
}

export function authenticateBackupReport(
  headers: Headers,
  rawBody: Uint8Array,
  payload: BackupReportPayload,
): { nonce: string; bodySha256: string } {
  const serverId = headers.get("x-ivrm-agent-id") ?? "";
  const timestamp = headers.get("x-ivrm-timestamp") ?? "";
  const nonce = headers.get("x-ivrm-nonce") ?? "";
  const signature = headers.get("x-ivrm-signature") ?? "";

  if (serverId !== payload.serverId) throw new BackupReportError(401, "agent_id_mismatch");
  if (!/^\d{10}$/.test(timestamp)) throw new BackupReportError(401, "invalid_timestamp");
  if (Math.abs(Date.now() / 1_000 - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) {
    throw new BackupReportError(401, "expired_request");
  }
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new BackupReportError(401, "invalid_nonce");
  if (!/^[a-f0-9]{64}$/.test(signature)) throw new BackupReportError(401, "invalid_signature");

  const secret = readAgentSecrets()[serverId];
  if (!secret) throw new BackupReportError(401, "unknown_agent");

  const expected = createHmac("sha256", secret)
    .update(timestamp).update(".").update(nonce).update(".").update(rawBody).digest();
  const provided = Buffer.from(signature, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new BackupReportError(401, "invalid_signature");
  }

  return {
    nonce,
    bodySha256: createHash("sha256").update(rawBody).digest("hex"),
  };
}

function supabaseConfiguration(): { url: string; serviceRoleKey: string } {
  return {
    url: requireEnvironment("SUPABASE_URL").replace(/\/$/, ""),
    serviceRoleKey: requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

function handlePersistResult(result: PersistResult): void {
  if (result === "accepted") return;
  if (result === "unknown_agent") throw new BackupReportError(401, result);
  if (result === "rate_limited") throw new BackupReportError(429, result);
  if (result === "replayed_request") throw new BackupReportError(409, result);
  throw new BackupReportError(400, "invalid_payload");
}

export async function persistBackupReport(
  payload: BackupReportPayload,
  nonce: string,
  bodySha256: string,
): Promise<void> {
  const { url, serviceRoleKey } = supabaseConfiguration();
  const response = await fetch(`${url}/rest/v1/rpc/ingest_backup_report_v1`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_server_id: payload.serverId,
      p_reported_at: payload.reportedAt,
      p_request_nonce: nonce,
      p_body_sha256: bodySha256,
      p_runs: payload.runs,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new BackupReportError(503, "storage_unavailable");
  const result = (await response.json()) as PersistResult;
  if (![
    "accepted",
    "unknown_agent",
    "rate_limited",
    "replayed_request",
    "invalid_payload",
  ].includes(result)) {
    throw new BackupReportError(503, "storage_unavailable");
  }
  handlePersistResult(result);
}
