import type { BackupType } from "./backup-report";

const BACKUP_TYPES = new Set<BackupType>(["world", "config", "permissions", "full"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BackupIncidentContext = {
  hostId: string;
  serverId: string;
  hostDisplayName: string;
  backupTarget: string;
  gameMode: string;
  backupType: BackupType;
  failureStartedAt: string | null;
  consecutiveFailureCount: number;
  checksumStartedAt: string | null;
  relatedRunCount: number;
};

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}が設定されていません`);
  return value;
}

function timestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

function text(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : null;
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseContext(payload: unknown): BackupIncidentContext[] {
  if (!Array.isArray(payload)) {
    throw new Error("Backup Incident Contextレスポンスが配列ではありません");
  }

  return payload.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Backup Incident Context行が不正です");
    }
    const row = value as Record<string, unknown>;
    const hostId = text(row.host_id, 36);
    const serverId = text(row.server_id, 64);
    const hostDisplayName = text(row.host_display_name, 256);
    const backupTarget = text(row.backup_target, 64);
    const gameMode = text(row.game_mode, 64);
    const backupType = text(row.backup_type, 32) as BackupType | null;
    const failureStartedAt = timestamp(row.failure_started_at);
    const consecutiveFailureCount = integer(row.consecutive_failure_count);
    const checksumStartedAt = timestamp(row.checksum_started_at);
    const relatedRunCount = integer(row.related_run_count);

    if (
      !hostId ||
      !UUID_PATTERN.test(hostId) ||
      !serverId ||
      !hostDisplayName ||
      !backupTarget ||
      !gameMode ||
      !backupType ||
      !BACKUP_TYPES.has(backupType) ||
      failureStartedAt === undefined ||
      checksumStartedAt === undefined ||
      (failureStartedAt === null && checksumStartedAt === null) ||
      consecutiveFailureCount === null ||
      consecutiveFailureCount < 0 ||
      relatedRunCount === null ||
      relatedRunCount < 0
    ) {
      throw new Error("Backup Incident Contextレスポンス形式が不正です");
    }

    return {
      hostId,
      serverId,
      hostDisplayName,
      backupTarget,
      gameMode,
      backupType,
      failureStartedAt,
      consecutiveFailureCount,
      checksumStartedAt,
      relatedRunCount,
    };
  });
}

export async function getBackupIncidentContext(before: string): Promise<BackupIncidentContext[]> {
  if (!Number.isFinite(Date.parse(before))) {
    throw new Error("Backup Incident Context境界が不正です");
  }

  const url = requireEnvironment("SUPABASE_URL").replace(/\/$/, "");
  const serviceRoleKey = requireEnvironment("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${url}/rest/v1/rpc/get_backup_incident_context_v1`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ p_before: before }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`get_backup_incident_context_v1が${response.status}を返しました`);
  }

  return parseContext(await response.json());
}
