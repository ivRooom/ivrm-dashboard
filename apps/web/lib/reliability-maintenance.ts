import "server-only";

import type {
  ReliabilityBackupType,
  ReliabilityMaintenanceScopeType,
  ReliabilityMaintenanceTargetCatalog,
  ReliabilityMaintenanceWindow,
  ReliabilitySloServiceId,
} from "./reliability-types";
import {
  RELIABILITY_CONTAINER_NAME_PATTERN,
  RELIABILITY_DISCORD_SNOWFLAKE_PATTERN,
  RELIABILITY_TARGET_NAME_PATTERN,
  RELIABILITY_UUID_PATTERN,
  isReliabilityBackupType,
  isReliabilityMaintenanceScopeType,
  isReliabilitySloServiceId,
} from "./reliability-maintenance-validation";

const WINDOW_PAGE_SIZE = 200;
const MAX_WINDOW_PAGES = 25;

type WindowRow = {
  id: unknown;
  scope_type: unknown;
  service_id: unknown;
  host_id: unknown;
  container_name: unknown;
  backup_target: unknown;
  game_mode: unknown;
  backup_type: unknown;
  starts_at: unknown;
  ends_at: unknown;
  reason: unknown;
  cancelled_at: unknown;
  created_at: unknown;
};

type HostRow = {
  id: unknown;
  server_id: unknown;
  display_name: unknown;
  enabled?: unknown;
};

type TargetCatalogRow = {
  scope_type: unknown;
  host_id: unknown;
  server_id: unknown;
  host_display_name: unknown;
  container_name: unknown;
  backup_target: unknown;
  game_mode: unknown;
  backup_type: unknown;
};

type HostLabel = { serverId: string; displayName: string; enabled: boolean };

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}が設定されていません`);
  return value;
}

function configuration(): { url: string; serviceRoleKey: string } {
  return {
    url: requireEnvironment("SUPABASE_URL").replace(/\/$/, ""),
    serviceRoleKey: requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

function headers(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function parseTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function parseHosts(payload: unknown): Map<string, HostLabel> {
  if (!Array.isArray(payload)) throw new Error("Reliability Maintenance Host一覧が配列ではありません");
  const hosts = new Map<string, HostLabel>();
  for (const item of payload) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Reliability Maintenance Host行が不正です");
    }
    const row = item as HostRow;
    if (
      typeof row.id !== "string" ||
      !RELIABILITY_UUID_PATTERN.test(row.id) ||
      typeof row.server_id !== "string" ||
      typeof row.display_name !== "string" ||
      (row.enabled !== undefined && typeof row.enabled !== "boolean")
    ) {
      throw new Error("Reliability Maintenance Host形式が不正です");
    }
    hosts.set(row.id, {
      serverId: row.server_id,
      displayName: row.display_name,
      enabled: row.enabled === undefined ? true : row.enabled,
    });
  }
  return hosts;
}

function parseWindow(row: WindowRow, hosts: Map<string, HostLabel>): ReliabilityMaintenanceWindow {
  const startsAt = parseTimestamp(row.starts_at);
  const endsAt = parseTimestamp(row.ends_at);
  const cancelledAt = row.cancelled_at === null ? null : parseTimestamp(row.cancelled_at);
  const createdAt = parseTimestamp(row.created_at);
  const serviceId = nullableString(row.service_id);
  const hostId = nullableString(row.host_id);
  const containerName = nullableString(row.container_name);
  const backupTarget = nullableString(row.backup_target);
  const gameMode = nullableString(row.game_mode);
  const backupType = nullableString(row.backup_type);

  if (
    typeof row.id !== "string" ||
    !RELIABILITY_UUID_PATTERN.test(row.id) ||
    !isReliabilityMaintenanceScopeType(row.scope_type) ||
    serviceId === undefined ||
    hostId === undefined ||
    containerName === undefined ||
    backupTarget === undefined ||
    gameMode === undefined ||
    backupType === undefined ||
    !startsAt ||
    !endsAt ||
    (row.cancelled_at !== null && !cancelledAt) ||
    !createdAt ||
    typeof row.reason !== "string" ||
    row.reason.length < 1 ||
    row.reason.length > 200
  ) {
    throw new Error("Reliability Maintenance Window形式が不正です");
  }

  if (serviceId !== null && !isReliabilitySloServiceId(serviceId)) {
    throw new Error("Reliability Maintenance serviceIdが不正です");
  }
  if (hostId !== null && !RELIABILITY_UUID_PATTERN.test(hostId)) {
    throw new Error("Reliability Maintenance hostIdが不正です");
  }
  if (containerName !== null && !RELIABILITY_CONTAINER_NAME_PATTERN.test(containerName)) {
    throw new Error("Reliability Maintenance containerNameが不正です");
  }
  if (backupTarget !== null && !RELIABILITY_TARGET_NAME_PATTERN.test(backupTarget)) {
    throw new Error("Reliability Maintenance backupTargetが不正です");
  }
  if (gameMode !== null && !RELIABILITY_TARGET_NAME_PATTERN.test(gameMode)) {
    throw new Error("Reliability Maintenance gameModeが不正です");
  }
  if (backupType !== null && !isReliabilityBackupType(backupType)) {
    throw new Error("Reliability Maintenance backupTypeが不正です");
  }

  const scopeType = row.scope_type;
  const shapeValid =
    (scopeType === "service" && serviceId !== null && hostId === null && containerName === null && backupTarget === null && gameMode === null && backupType === null) ||
    (scopeType === "host" && serviceId === null && hostId !== null && containerName === null && backupTarget === null && gameMode === null && backupType === null) ||
    (scopeType === "container" && serviceId === null && hostId !== null && containerName !== null && backupTarget === null && gameMode === null && backupType === null) ||
    (scopeType === "backup" && serviceId === null && hostId !== null && containerName === null && backupTarget !== null && gameMode !== null && backupType !== null);
  if (!shapeValid) throw new Error("Reliability Maintenance Window対象構造が不正です");

  const host = hostId ? hosts.get(hostId) ?? null : null;
  return {
    id: row.id,
    scopeType,
    serviceId: serviceId as ReliabilitySloServiceId | null,
    hostId,
    serverId: host?.serverId ?? null,
    hostDisplayName: host?.displayName ?? null,
    containerName,
    backupTarget,
    gameMode,
    backupType: backupType as ReliabilityBackupType | null,
    startsAt,
    endsAt,
    reason: row.reason,
    cancelledAt,
    createdAt,
  };
}

async function fetchJson(path: string, signalMs = 5_000): Promise<unknown> {
  const { url, serviceRoleKey } = configuration();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: headers(serviceRoleKey),
    cache: "no-store",
    signal: AbortSignal.timeout(signalMs),
  });
  if (!response.ok) {
    throw new Error(`Reliability Maintenance APIが${response.status}を返しました`);
  }
  return (await response.json()) as unknown;
}

async function callRpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const { url, serviceRoleKey } = configuration();
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: headers(serviceRoleKey),
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Reliability Maintenance ${name} RPCが${response.status}を返しました`);
  }
  return (await response.json()) as unknown;
}

async function getHostMap(): Promise<Map<string, HostLabel>> {
  return parseHosts(
    await fetchJson("hosts?select=id,server_id,display_name,enabled&order=server_id.asc&limit=500"),
  );
}

async function getWindowRows(input: {
  rangeStart: string;
  horizon: string;
}): Promise<WindowRow[]> {
  const rows: WindowRow[] = [];

  for (let page = 0; page < MAX_WINDOW_PAGES; page += 1) {
    const params = new URLSearchParams({
      select:
        "id,scope_type,service_id,host_id,container_name,backup_target,game_mode,backup_type,starts_at,ends_at,reason,cancelled_at,created_at",
      starts_at: `lt.${input.horizon}`,
      ends_at: `gt.${input.rangeStart}`,
      order: "starts_at.asc,id.asc",
      limit: String(WINDOW_PAGE_SIZE),
      offset: String(page * WINDOW_PAGE_SIZE),
    });
    const payload = await fetchJson(`reliability_maintenance_windows?${params.toString()}`);
    if (!Array.isArray(payload)) {
      throw new Error("Reliability Maintenance Window一覧が配列ではありません");
    }
    for (const item of payload) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error("Reliability Maintenance Window行が不正です");
      }
      rows.push(item as WindowRow);
    }
    if (payload.length < WINDOW_PAGE_SIZE) return rows;
  }

  throw new Error(
    `Reliability Maintenance Windowが${WINDOW_PAGE_SIZE * MAX_WINDOW_PAGES}件を超えたため完全取得できません`,
  );
}

export async function getReliabilityMaintenanceWindows(input: {
  rangeStart: string;
  generatedAt: string;
  upcomingDays?: number;
}): Promise<ReliabilityMaintenanceWindow[]> {
  const rangeStartMs = Date.parse(input.rangeStart);
  const generatedAtMs = Date.parse(input.generatedAt);
  if (!Number.isFinite(rangeStartMs) || !Number.isFinite(generatedAtMs)) {
    throw new Error("Reliability Maintenance取得期間が不正です");
  }
  const upcomingDays = Math.min(Math.max(input.upcomingDays ?? 30, 1), 90);
  const horizon = new Date(generatedAtMs + upcomingDays * 86_400_000).toISOString();

  const [rows, hosts] = await Promise.all([
    getWindowRows({ rangeStart: input.rangeStart, horizon }),
    getHostMap(),
  ]);

  return rows
    .map((row) => parseWindow(row, hosts))
    .filter((window) => {
      const effectiveEnd = Math.min(
        Date.parse(window.endsAt),
        window.cancelledAt ? Date.parse(window.cancelledAt) : Number.POSITIVE_INFINITY,
      );
      return effectiveEnd > rangeStartMs || Date.parse(window.startsAt) > generatedAtMs;
    });
}

export async function getReliabilityMaintenanceTargets(): Promise<ReliabilityMaintenanceTargetCatalog> {
  const payload = await callRpc("list_reliability_maintenance_targets_v1", {});
  if (!Array.isArray(payload)) {
    throw new Error("Reliability Maintenance Target一覧が配列ではありません");
  }

  const catalog: ReliabilityMaintenanceTargetCatalog = {
    hosts: [],
    containers: [],
    backups: [],
  };

  for (const item of payload) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Reliability Maintenance Target行が不正です");
    }
    const row = item as TargetCatalogRow;
    if (
      (row.scope_type !== "host" && row.scope_type !== "container" && row.scope_type !== "backup") ||
      typeof row.host_id !== "string" ||
      !RELIABILITY_UUID_PATTERN.test(row.host_id) ||
      typeof row.server_id !== "string" ||
      typeof row.host_display_name !== "string"
    ) {
      throw new Error("Reliability Maintenance Target共通形式が不正です");
    }

    if (row.scope_type === "host") {
      if (
        row.container_name !== null ||
        row.backup_target !== null ||
        row.game_mode !== null ||
        row.backup_type !== null
      ) {
        throw new Error("Reliability Maintenance Host Target形式が不正です");
      }
      catalog.hosts.push({
        hostId: row.host_id,
        serverId: row.server_id,
        displayName: row.host_display_name,
      });
      continue;
    }

    if (row.scope_type === "container") {
      if (
        typeof row.container_name !== "string" ||
        !RELIABILITY_CONTAINER_NAME_PATTERN.test(row.container_name) ||
        row.backup_target !== null ||
        row.game_mode !== null ||
        row.backup_type !== null
      ) {
        throw new Error("Reliability Maintenance Container Target形式が不正です");
      }
      catalog.containers.push({
        hostId: row.host_id,
        serverId: row.server_id,
        hostDisplayName: row.host_display_name,
        containerName: row.container_name,
      });
      continue;
    }

    if (
      row.container_name !== null ||
      typeof row.backup_target !== "string" ||
      !RELIABILITY_TARGET_NAME_PATTERN.test(row.backup_target) ||
      typeof row.game_mode !== "string" ||
      !RELIABILITY_TARGET_NAME_PATTERN.test(row.game_mode) ||
      !isReliabilityBackupType(row.backup_type)
    ) {
      throw new Error("Reliability Maintenance Backup Target形式が不正です");
    }
    catalog.backups.push({
      hostId: row.host_id,
      serverId: row.server_id,
      hostDisplayName: row.host_display_name,
      backupTarget: row.backup_target,
      gameMode: row.game_mode,
      backupType: row.backup_type,
    });
  }

  return catalog;
}

function validateIdentity(input: {
  actorEmail: string | null;
  actorDiscordUserId: string | null;
}): void {
  if (
    input.actorDiscordUserId !== null &&
    !RELIABILITY_DISCORD_SNOWFLAKE_PATTERN.test(input.actorDiscordUserId)
  ) {
    throw new Error("Maintenance actorDiscordUserIdが不正です");
  }
  if (!input.actorEmail && !input.actorDiscordUserId) {
    throw new Error("Maintenance監査主体が取得できません");
  }
}

async function callMutationRpc(
  name: string,
  body: Record<string, unknown>,
): Promise<ReliabilityMaintenanceWindow> {
  const payload = await callRpc(name, body);
  if (!Array.isArray(payload) || payload.length !== 1) {
    throw new Error(`Reliability Maintenance ${name}結果が不正です`);
  }
  const row = payload[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`Reliability Maintenance ${name}行が不正です`);
  }
  const hosts = await getHostMap().catch((error: unknown) => {
    console.error("Reliability Maintenance mutation後のHost表示名取得に失敗しました", error);
    return new Map<string, HostLabel>();
  });
  return parseWindow(row as WindowRow, hosts);
}

export async function createReliabilityMaintenanceWindow(input: {
  scopeType: ReliabilityMaintenanceScopeType;
  serviceId: ReliabilitySloServiceId | null;
  hostId: string | null;
  containerName: string | null;
  backupTarget: string | null;
  gameMode: string | null;
  backupType: ReliabilityBackupType | null;
  startsAt: string;
  endsAt: string;
  reason: string;
  idempotencyKey: string;
  actorEmail: string | null;
  actorDiscordUserId: string | null;
  actorRole: "administrator" | "owner";
}): Promise<ReliabilityMaintenanceWindow> {
  validateIdentity(input);
  if (!isReliabilityMaintenanceScopeType(input.scopeType)) {
    throw new Error("Maintenance scopeTypeが不正です");
  }
  if (!RELIABILITY_UUID_PATTERN.test(input.idempotencyKey)) {
    throw new Error("Maintenance idempotencyKeyが不正です");
  }
  if (!Number.isFinite(Date.parse(input.startsAt)) || !Number.isFinite(Date.parse(input.endsAt))) {
    throw new Error("Maintenance日時が不正です");
  }
  if (input.reason.trim().length < 1 || input.reason.trim().length > 200) {
    throw new Error("Maintenance reasonが不正です");
  }

  return callMutationRpc("create_reliability_maintenance_window_v2", {
    p_scope_type: input.scopeType,
    p_service_id: input.serviceId,
    p_host_id: input.hostId,
    p_container_name: input.containerName,
    p_backup_target: input.backupTarget,
    p_game_mode: input.gameMode,
    p_backup_type: input.backupType,
    p_starts_at: input.startsAt,
    p_ends_at: input.endsAt,
    p_reason: input.reason.trim(),
    p_idempotency_key: input.idempotencyKey,
    p_actor_email: input.actorEmail,
    p_actor_role: input.actorRole,
    p_actor_discord_user_id: input.actorDiscordUserId,
  });
}

export async function cancelReliabilityMaintenanceWindow(input: {
  windowId: string;
  requestId: string;
  actorEmail: string | null;
  actorDiscordUserId: string | null;
  actorRole: "administrator" | "owner";
}): Promise<ReliabilityMaintenanceWindow> {
  validateIdentity(input);
  if (!RELIABILITY_UUID_PATTERN.test(input.requestId)) throw new Error("Maintenance requestIdが不正です");
  if (!RELIABILITY_UUID_PATTERN.test(input.windowId)) throw new Error("Maintenance windowIdが不正です");
  return callMutationRpc("cancel_reliability_maintenance_window_v1", {
    p_window_id: input.windowId,
    p_request_id: input.requestId,
    p_actor_email: input.actorEmail,
    p_actor_role: input.actorRole,
    p_actor_discord_user_id: input.actorDiscordUserId,
  });
}
