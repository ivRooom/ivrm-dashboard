import { hashOpaqueToken, discordAvatarUrl } from "./discord-auth";
import type { ConsoleRole } from "./console-auth";

export type DiscordSessionStatus = "active" | "expired" | "revoked" | "all";
export type DiscordSessionResolvedStatus = Exclude<DiscordSessionStatus, "all">;
export type DiscordAuthAuditAction =
  | "DISCORD_LOGIN_SUCCEEDED"
  | "DISCORD_LOGIN_DENIED"
  | "DISCORD_SESSION_REVOKED"
  | "DISCORD_SESSION_ADMIN_REVOKED";
export type AuditResult = "success" | "denied" | "conflict" | "error";

export type DiscordSessionAdminRow = {
  sessionId: string;
  discordUserId: string;
  discordUsername: string;
  discordGlobalName: string | null;
  discordAvatarUrl: string | null;
  consoleRole: ConsoleRole;
  status: DiscordSessionResolvedStatus;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
  isCurrent: boolean;
};

export type DiscordAuthAuditRow = {
  auditId: number;
  requestId: string;
  action: DiscordAuthAuditAction;
  result: AuditResult;
  actorRole: ConsoleRole | null;
  targetId: string | null;
  discordUserId: string | null;
  reason: string | null;
  providerError: string | null;
  consoleRole: ConsoleRole | null;
  occurredAt: string;
};

export type DiscordSessionRevokeOutcome =
  | "revoked"
  | "unchanged"
  | "denied"
  | "not_found";

export type DiscordSessionRevokeResult = {
  outcome: DiscordSessionRevokeOutcome;
  targetWasCurrent: boolean;
  targetConsoleRole: ConsoleRole | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/;
const PROVIDER_ERROR_PATTERN = /^[a-z0-9_]{1,64}$/;
const SESSION_STATUSES = new Set<DiscordSessionStatus>([
  "active",
  "expired",
  "revoked",
  "all",
]);
const RESOLVED_SESSION_STATUSES = new Set<DiscordSessionResolvedStatus>([
  "active",
  "expired",
  "revoked",
]);
const CONSOLE_ROLES = new Set<ConsoleRole>([
  "viewer",
  "operator",
  "administrator",
  "owner",
]);
const AUDIT_ACTIONS = new Set<DiscordAuthAuditAction>([
  "DISCORD_LOGIN_SUCCEEDED",
  "DISCORD_LOGIN_DENIED",
  "DISCORD_SESSION_REVOKED",
  "DISCORD_SESSION_ADMIN_REVOKED",
]);
const AUDIT_RESULTS = new Set<AuditResult>([
  "success",
  "denied",
  "conflict",
  "error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name}が設定されていません`);
  }
  return value;
}

function supabaseConfiguration(): { url: string; serviceRoleKey: string } {
  return {
    url: requireEnvironment("SUPABASE_URL").replace(/\/$/, ""),
    serviceRoleKey: requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

async function callSupabaseRpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
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
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`Supabase RPC ${name}が${response.status}を返しました`);
  }
  return (await response.json()) as T;
}

function isConsoleRole(value: unknown): value is ConsoleRole {
  return typeof value === "string" && CONSOLE_ROLES.has(value as ConsoleRole);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseProviderError(value: unknown): string | null {
  return typeof value === "string" && PROVIDER_ERROR_PATTERN.test(value)
    ? value
    : null;
}

function parseSessionRow(value: unknown): DiscordSessionAdminRow | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.session_id !== "string" ||
    !UUID_PATTERN.test(value.session_id) ||
    typeof value.discord_user_id !== "string" ||
    !SNOWFLAKE_PATTERN.test(value.discord_user_id) ||
    typeof value.discord_username !== "string" ||
    !isNullableString(value.discord_global_name) ||
    !isNullableString(value.discord_avatar_hash) ||
    !isConsoleRole(value.console_role) ||
    typeof value.session_status !== "string" ||
    !RESOLVED_SESSION_STATUSES.has(value.session_status as DiscordSessionResolvedStatus) ||
    typeof value.created_at !== "string" ||
    typeof value.last_seen_at !== "string" ||
    typeof value.expires_at !== "string" ||
    !isNullableString(value.revoked_at) ||
    !isNullableString(value.revoke_reason) ||
    typeof value.is_current !== "boolean"
  ) {
    return null;
  }

  return {
    sessionId: value.session_id,
    discordUserId: value.discord_user_id,
    discordUsername: value.discord_username,
    discordGlobalName: value.discord_global_name,
    discordAvatarUrl: discordAvatarUrl(
      value.discord_user_id,
      value.discord_avatar_hash,
    ),
    consoleRole: value.console_role,
    status: value.session_status as DiscordSessionResolvedStatus,
    createdAt: value.created_at,
    lastSeenAt: value.last_seen_at,
    expiresAt: value.expires_at,
    revokedAt: value.revoked_at,
    revokeReason: value.revoke_reason,
    isCurrent: value.is_current,
  };
}

function parseAuditRow(value: unknown): DiscordAuthAuditRow | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.audit_id !== "number" ||
    !Number.isSafeInteger(value.audit_id) ||
    value.audit_id < 1 ||
    typeof value.request_id !== "string" ||
    !UUID_PATTERN.test(value.request_id) ||
    typeof value.action !== "string" ||
    !AUDIT_ACTIONS.has(value.action as DiscordAuthAuditAction) ||
    typeof value.result !== "string" ||
    !AUDIT_RESULTS.has(value.result as AuditResult) ||
    (value.actor_role !== null && !isConsoleRole(value.actor_role)) ||
    !isNullableString(value.target_id) ||
    !isNullableString(value.discord_user_id) ||
    !isNullableString(value.reason) ||
    !isNullableString(value.provider_error) ||
    (value.console_role !== null && !isConsoleRole(value.console_role)) ||
    typeof value.occurred_at !== "string"
  ) {
    return null;
  }

  return {
    auditId: value.audit_id,
    requestId: value.request_id,
    action: value.action as DiscordAuthAuditAction,
    result: value.result as AuditResult,
    actorRole: value.actor_role as ConsoleRole | null,
    targetId: value.target_id,
    discordUserId: value.discord_user_id,
    reason: value.reason,
    providerError: parseProviderError(value.provider_error),
    consoleRole: value.console_role as ConsoleRole | null,
    occurredAt: value.occurred_at,
  };
}

export function parseDiscordSessionStatus(value: string | null): DiscordSessionStatus {
  return value && SESSION_STATUSES.has(value as DiscordSessionStatus)
    ? (value as DiscordSessionStatus)
    : "active";
}

export function parseDiscordAuditAction(value: string | null): DiscordAuthAuditAction | null {
  return value && AUDIT_ACTIONS.has(value as DiscordAuthAuditAction)
    ? (value as DiscordAuthAuditAction)
    : null;
}

export function parseAuditResult(value: string | null): AuditResult | null {
  return value && AUDIT_RESULTS.has(value as AuditResult)
    ? (value as AuditResult)
    : null;
}

export function parseUuid(value: string | null): string | null {
  return value && UUID_PATTERN.test(value) ? value : null;
}

export function parsePositiveInteger(value: string | null): number | null {
  if (!value || !/^[0-9]+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function listDiscordConsoleSessions(input: {
  actorSessionToken: string;
  status?: DiscordSessionStatus;
  limit?: number;
  beforeCreatedAt?: string | null;
  beforeId?: string | null;
}): Promise<DiscordSessionAdminRow[]> {
  const rows = await callSupabaseRpc<unknown[]>("list_discord_console_sessions", {
    p_actor_session_token_hash: hashOpaqueToken(input.actorSessionToken),
    p_status: input.status ?? "active",
    p_limit: Math.min(Math.max(input.limit ?? 50, 1), 100),
    p_before_created_at: input.beforeCreatedAt ?? null,
    p_before_id: input.beforeId ?? null,
  });

  if (!Array.isArray(rows)) {
    throw new Error("Discord Session一覧レスポンスが不正です");
  }
  return rows.map(parseSessionRow).filter((row): row is DiscordSessionAdminRow => row !== null);
}

export async function revokeDiscordConsoleSessionById(input: {
  requestId: string;
  actorSessionToken: string;
  targetSessionId: string;
}): Promise<DiscordSessionRevokeResult> {
  if (!UUID_PATTERN.test(input.requestId) || !UUID_PATTERN.test(input.targetSessionId)) {
    throw new Error("Discord Session失効要求が不正です");
  }

  const rows = await callSupabaseRpc<unknown[]>("revoke_discord_console_session_by_id", {
    p_request_id: input.requestId,
    p_actor_session_token_hash: hashOpaqueToken(input.actorSessionToken),
    p_target_session_id: input.targetSessionId,
  });

  if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])) {
    throw new Error("Discord Session失効レスポンスが不正です");
  }
  const row = rows[0];
  const outcome = row.outcome;
  if (
    typeof outcome !== "string" ||
    !["revoked", "unchanged", "denied", "not_found"].includes(outcome) ||
    typeof row.target_was_current !== "boolean" ||
    (row.target_console_role !== null && !isConsoleRole(row.target_console_role))
  ) {
    throw new Error("Discord Session失効結果が不正です");
  }

  return {
    outcome: outcome as DiscordSessionRevokeOutcome,
    targetWasCurrent: row.target_was_current,
    targetConsoleRole: row.target_console_role as ConsoleRole | null,
  };
}

export async function listDiscordAuthAuditLogs(input: {
  actorSessionToken: string;
  action?: DiscordAuthAuditAction | null;
  result?: AuditResult | null;
  limit?: number;
  beforeOccurredAt?: string | null;
  beforeId?: number | null;
}): Promise<DiscordAuthAuditRow[]> {
  const rows = await callSupabaseRpc<unknown[]>("list_discord_auth_audit_logs", {
    p_actor_session_token_hash: hashOpaqueToken(input.actorSessionToken),
    p_action: input.action ?? null,
    p_result: input.result ?? null,
    p_limit: Math.min(Math.max(input.limit ?? 50, 1), 100),
    p_before_occurred_at: input.beforeOccurredAt ?? null,
    p_before_id: input.beforeId ?? null,
  });

  if (!Array.isArray(rows)) {
    throw new Error("Discord認証監査レスポンスが不正です");
  }
  return rows.map(parseAuditRow).filter((row): row is DiscordAuthAuditRow => row !== null);
}
