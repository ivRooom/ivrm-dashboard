import "server-only";

import type {
  ReliabilityMaintenanceScopeType,
  ReliabilityMaintenanceTargetCatalog,
  ReliabilityMaintenanceWindow,
  ReliabilitySloServiceId,
} from "./reliability-types";

const SERVICE_IDS = new Set<ReliabilitySloServiceId>([
  "overall",
  "host",
  "container",
  "backup",
]);
const SCOPE_TYPES = new Set<ReliabilityMaintenanceScopeType>([
  "service",
  "host",
  "container",
  "backup",
]);
const BACKUP_TYPES = new Set(["world", "config", "permissions", "full"] as const);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISCORD_SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/;
const CONTAINER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

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

type ContainerRow = {
  host_id: unknown;
  container_name: unknown;
};

type BackupRow = {
  host_id: unknown;
  backup_target: unknown;
  game_mode: unknown;
  backup_type: unknown;
  enabled: unknown;
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
      !UUID_PATTERN.test(row.id) ||
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
    !UUID_PATTERN.test(row.id) ||
    typeof row.scope_type !== "string" ||
    !SCOPE_TYPES.has(row.scope_type as ReliabilityMaintenanceScopeType) ||
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

  if (serviceId !== null && !SERVICE_IDS.has(serviceId as ReliabilitySloServiceId)) {
    throw new Error("Reliability Maintenance serviceIdが不正です");
  }
  if (hostId !== null && !UUID_PATTERN.test(hostId)) {
    throw new Error("Reliability Maintenance hostIdが不正です");
  }
  if (containerName !== null && !CONTAINER_PATTERN.test(containerName)) {
    throw new Error("Reliability Maintenance containerNameが不正です");
  }
  if (backupTarget !== null && !TARGET_PATTERN.test(backupTarget)) {
    throw new Error("Reliability Maintenance backupTargetが不正です");
  }
  if (gameMode !== null && !TARGET_PATTERN.test(gameMode)) {
    throw new Error("Reliability Maintenance gameModeが不正です");
  }
  if (
    backupType !== null &&
    !BACKUP_TYPES.has(backupType as "world" | "config" | "permissions" | "full")
  ) {
    throw new Error("Reliability Maintenance backupTypeが不正です");
  }

  const scopeType = row.scope_type as ReliabilityMaintenanceScopeType;
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
    backupType: backupType as ReliabilityMaintenanceWindow["backupType"],
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

async function getHostMap(): Promise<Map<string, HostLabel>> {
  return parseHosts(
    await fetchJson("hosts?select=id,server_id,display_name,enabled&order=server_id.asc&limit=500"),
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
  const params = new URLSearchParams({
    select:
      "id,scope_type,service_id,host_id,container_name,backup_target,game_mode,backup_type,starts_at,ends_at,reason,cancelled_at,created_at",
    starts_at: `lt.${horizon}`,
    ends_at: `gt.${input.rangeStart}`,
    order: "starts_at.asc",
    limit: "200",
  });

  const [payload, hosts] = await Promise.all([
    fetchJson(`reliability_maintenance_windows?${params.toString()}`),
    getHostMap(),
  ]);
  if (!Array.isArray(payload)) {
    throw new Error("Reliability Maintenance Window一覧が配列ではありません");
  }

  return payload
    .map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error("Reliability Maintenance Window行が不正です");
      }
      return parseWindow(item as WindowRow, hosts);
    })
    .filter((window) => {
      const effectiveEnd = Math.min(
        Date.parse(window.endsAt),
        window.cancelledAt ? Date.parse(window.cancelledAt) : Number.POSITIVE_INFINITY,
      );
      return effectiveEnd > rangeStartMs || Date.parse(window.startsAt) > generatedAtMs;
    });
}

export async function getReliabilityMaintenanceTargets(): Promise<ReliabilityMaintenanceTargetCatalog> {
  const [hostPayload, containerPayload, backupPayload] = await Promise.all([
    fetchJson("hosts?select=id,server_id,display_name,enabled&enabled=eq.true&order=server_id.asc&limit=500"),
    fetchJson("container_expectations?select=host_id,container_name&order=host_id.asc,container_name.asc&limit=1000"),
    fetchJson("backup_policies?select=host_id,backup_target,game_mode,backup_type,enabled&enabled=eq.true&order=host_id.asc,backup_target.asc&limit=1000"),
  ]);
  const hosts = parseHosts(hostPayload);
  if (!Array.isArray(containerPayload) || !Array.isArray(backupPayload)) {
    throw new Error("Reliability Maintenance Target一覧が不正です");
  }

  const hostTargets = [...hosts.entries()]
    .filter(([, host]) => host.enabled)
    .map(([hostId, host]) => ({
      hostId,
      serverId: host.serverId,
      displayName: host.displayName,
    }));

  const containers = containerPayload.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Reliability Maintenance Container行が不正です");
    }
    const row = item as ContainerRow;
    if (
      typeof row.host_id !== "string" ||
      !UUID_PATTERN.test(row.host_id) ||
      typeof row.container_name !== "string" ||
      !CONTAINER_PATTERN.test(row.container_name)
    ) {
      throw new Error("Reliability Maintenance Container形式が不正です");
    }
    const host = hosts.get(row.host_id);
    if (!host?.enabled) return null;
    return {
      hostId: row.host_id,
      serverId: host.serverId,
      hostDisplayName: host.displayName,
      containerName: row.container_name,
    };
  }).filter((item): item is ReliabilityMaintenanceTargetCatalog["containers"][number] => item !== null);

  const backups = backupPayload.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Reliability Maintenance Backup行が不正です");
    }
    const row = item as BackupRow;
    if (
      typeof row.host_id !== "string" ||
      !UUID_PATTERN.test(row.host_id) ||
      typeof row.backup_target !== "string" ||
      !TARGET_PATTERN.test(row.backup_target) ||
      typeof row.game_mode !== "string" ||
      !TARGET_PATTERN.test(row.game_mode) ||
      typeof row.backup_type !== "string" ||
      !BACKUP_TYPES.has(row.backup_type as "world" | "config" | "permissions" | "full") ||
      row.enabled !== true
    ) {
      throw new Error("Reliability Maintenance Backup形式が不正です");
    }
    const host = hosts.get(row.host_id);
    if (!host?.enabled) return null;
    return {
      hostId: row.host_id,
      serverId: host.serverId,
      hostDisplayName: host.displayName,
      backupTarget: row.backup_target,
      gameMode: row.game_mode,
      backupType: row.backup_type as "world" | "config" | "permissions" | "full",
    };
  }).filter((item): item is ReliabilityMaintenanceTargetCatalog["backups"][number] => item !== null);

  return { hosts: hostTargets, containers, backups };
}

function validateActor(input: {
  requestId: string;
  actorEmail: string | null;
  actorDiscordUserId: string | null;
}): void {
  if (!UUID_PATTERN.test(input.requestId)) throw new Error("Maintenance requestIdが不正です");
  if (
    input.actorDiscordUserId !== null &&
    !DISCORD_SNOWFLAKE_PATTERN.test(input.actorDiscordUserId)
  ) {
    throw new Error("Maintenance actorDiscordUserIdが不正です");
  }
  if (!input.actorEmail && !input.actorDiscordUserId) {
    throw new Error("Maintenance監査主体が取得できません");
  }
}

async function callMutationRpc(name: string, body: Record<string, unknown>): Promise<ReliabilityMaintenanceWindow> {
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
  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload) || payload.length !== 1) {
    throw new Error(`Reliability Maintenance ${name}結果が不正です`);
  }
  const row = payload[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`Reliability Maintenance ${name}行が不正です`);
  }
  return parseWindow(row as WindowRow, new Map());
}

export async function createReliabilityMaintenanceWindow(input: {
  scopeType: ReliabilityMaintenanceScopeType;
  serviceId: ReliabilitySloServiceId | null;
  hostId: string | null;
  containerName: string | null;
  backupTarget: string | null;
  gameMode: string | null;
  backupType: "world" | "config" | "permissions" | "full" | null;
  startsAt: string;
  endsAt: string;
  reason: string;
  requestId: string;
  actorEmail: string | null;
  actorDiscordUserId: string | null;
  actorRole: "administrator" | "owner";
}): Promise<ReliabilityMaintenanceWindow> {
  validateActor(input);
  if (!SCOPE_TYPES.has(input.scopeType)) throw new Error("Maintenance scopeTypeが不正です");
  if (!Number.isFinite(Date.parse(input.startsAt)) || !Number.isFinite(Date.parse(input.endsAt))) {
    throw new Error("Maintenance日時が不正です");
  }
  if (input.reason.trim().length < 1 || input.reason.trim().length > 200) {
    throw new Error("Maintenance reasonが不正です");
  }

  return callMutationRpc("create_reliability_maintenance_window_v1", {
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
    p_request_id: input.requestId,
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
  validateActor(input);
  if (!UUID_PATTERN.test(input.windowId)) throw new Error("Maintenance windowIdが不正です");
  return callMutationRpc("cancel_reliability_maintenance_window_v1", {
    p_window_id: input.windowId,
    p_request_id: input.requestId,
    p_actor_email: input.actorEmail,
    p_actor_role: input.actorRole,
    p_actor_discord_user_id: input.actorDiscordUserId,
  });
}
