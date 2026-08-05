import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ConsoleRole } from "./console-auth";

export type DiscordAuthMode = "disabled" | "report" | "enforce";

export type DiscordAuthConfiguration = {
  mode: Exclude<DiscordAuthMode, "disabled">;
  clientId: string;
  clientSecret: string;
  guildId: string;
  redirectUri: string;
  roleMap: Record<ConsoleRole, readonly string[]>;
  sessionTtlSeconds: number;
};

export type DiscordIdentity = {
  userId: string;
  username: string;
  globalName: string | null;
  avatarHash: string | null;
  roleIds: string[];
  pending: boolean;
};

export type DiscordRoleResolution = {
  consoleRole: ConsoleRole;
  matchedRoleIds: string[];
};

export type DiscordConsoleSessionRow = {
  sessionId: string;
  discordUserId: string;
  discordUsername: string;
  discordGlobalName: string | null;
  discordAvatarHash: string | null;
  guildId: string;
  matchedRoleIds: string[];
  consoleRole: ConsoleRole;
  createdAt: string;
  expiresAt: string;
};

export type DiscordLoginFailureReason =
  | "oauth_denied"
  | "oauth_state_invalid"
  | "oauth_code_missing"
  | "oauth_exchange_failed"
  | "discord_identity_invalid"
  | "guild_membership_required"
  | "membership_screening_pending"
  | "required_role_missing"
  | "session_create_failed"
  | "configuration_error";

export class DiscordAuthError extends Error {
  readonly reason: DiscordLoginFailureReason;

  constructor(reason: DiscordLoginFailureReason) {
    super(reason);
    this.name = "DiscordAuthError";
    this.reason = reason;
  }
}

export const DISCORD_SESSION_COOKIE = "__Host-ivrm_console_session";
export const DISCORD_OAUTH_STATE_COOKIE = "__Host-ivrm_discord_oauth_state";
export const DISCORD_OAUTH_RETURN_COOKIE = "__Host-ivrm_discord_oauth_return";
export const DISCORD_PUBLIC_ROUTE_HEADER = "x-ivrm-discord-public-route";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_ROLE_ORDER: ConsoleRole[] = [
  "owner",
  "administrator",
  "operator",
  "viewer",
];
const DISCORD_ROLE_SET = new Set<ConsoleRole>(DISCORD_ROLE_ORDER);
const SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/;
const SESSION_HASH_PATTERN = /^[0-9a-f]{64}$/;
const OAUTH_SCOPES = "identify guilds.members.read";

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name}が設定されていません`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConsoleRole(value: unknown): value is ConsoleRole {
  return typeof value === "string" && DISCORD_ROLE_SET.has(value as ConsoleRole);
}

function parseSnowflake(name: string, value: string): string {
  if (!SNOWFLAKE_PATTERN.test(value)) {
    throw new Error(`${name}がDiscord Snowflake形式ではありません`);
  }
  return value;
}

function parseRoleMap(raw: string): Record<ConsoleRole, readonly string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("IVRM_DISCORD_ROLE_MAP_JSONがJSONではありません");
  }

  if (!isRecord(parsed)) {
    throw new Error("IVRM_DISCORD_ROLE_MAP_JSONはObjectで指定してください");
  }

  for (const key of Object.keys(parsed)) {
    if (!isConsoleRole(key)) {
      throw new Error(`未対応のConsole Roleです: ${key}`);
    }
  }

  const result: Record<ConsoleRole, readonly string[]> = {
    viewer: [],
    operator: [],
    administrator: [],
    owner: [],
  };
  const seenRoleIds = new Set<string>();
  let configuredRoleCount = 0;

  for (const role of DISCORD_ROLE_ORDER) {
    const value = parsed[role] ?? [];
    if (!Array.isArray(value) || value.length > 16) {
      throw new Error(`${role}のRole IDは16件以内の配列で指定してください`);
    }

    const roleIds: string[] = [];
    for (const roleId of value) {
      if (typeof roleId !== "string" || !SNOWFLAKE_PATTERN.test(roleId)) {
        throw new Error(`${role}に不正なDiscord Role IDがあります`);
      }
      if (seenRoleIds.has(roleId)) {
        throw new Error(`Discord Role IDが複数Roleへ重複しています: ${roleId}`);
      }
      seenRoleIds.add(roleId);
      roleIds.push(roleId);
      configuredRoleCount += 1;
    }
    result[role] = Object.freeze(roleIds);
  }

  if (configuredRoleCount === 0) {
    throw new Error("Discord Role Mapには少なくとも1つのRole IDが必要です");
  }

  return Object.freeze(result);
}

function parseSessionTtl(): number {
  const raw = process.env.IVRM_DISCORD_SESSION_TTL_SECONDS?.trim() || "14400";
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error("IVRM_DISCORD_SESSION_TTL_SECONDSは整数で指定してください");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 300 || value > 86400) {
    throw new Error("Discord Session TTLは300〜86400秒で指定してください");
  }
  return value;
}

function parseRedirectUri(raw: string): string {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error("DISCORD_REDIRECT_URIがURLではありません");
  }

  const localDevelopment =
    value.protocol === "http:" &&
    (value.hostname === "localhost" || value.hostname === "127.0.0.1");
  if (value.protocol !== "https:" && !localDevelopment) {
    throw new Error("DISCORD_REDIRECT_URIはHTTPSを使用してください");
  }
  if (value.username || value.password || value.hash) {
    throw new Error("DISCORD_REDIRECT_URIに認証情報やFragmentは指定できません");
  }
  return value.toString();
}

export function getDiscordAuthMode(): DiscordAuthMode {
  const value = process.env.IVRM_DISCORD_AUTH_MODE?.trim().toLowerCase() || "disabled";
  if (value === "disabled" || value === "report" || value === "enforce") {
    return value;
  }
  throw new Error("IVRM_DISCORD_AUTH_MODEはdisabled、report、enforceのいずれかです");
}

export function getDiscordAuthConfiguration(): DiscordAuthConfiguration | null {
  const mode = getDiscordAuthMode();
  if (mode === "disabled") {
    return null;
  }

  const clientId = parseSnowflake("DISCORD_CLIENT_ID", requireEnvironment("DISCORD_CLIENT_ID"));
  const clientSecret = requireEnvironment("DISCORD_CLIENT_SECRET");
  const guildId = parseSnowflake("DISCORD_GUILD_ID", requireEnvironment("DISCORD_GUILD_ID"));
  const redirectUri = parseRedirectUri(requireEnvironment("DISCORD_REDIRECT_URI"));
  const roleMap = parseRoleMap(requireEnvironment("IVRM_DISCORD_ROLE_MAP_JSON"));

  return {
    mode,
    clientId,
    clientSecret,
    guildId,
    redirectUri,
    roleMap,
    sessionTtlSeconds: parseSessionTtl(),
  };
}

export function createDiscordAuthorizationUrl(
  configuration: DiscordAuthConfiguration,
  state: string,
): string {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", configuration.clientId);
  url.searchParams.set("scope", OAUTH_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", configuration.redirectUri);
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function sanitizeReturnPath(value: string | null): string {
  if (!value || value.length > 1024 || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  try {
    const parsed = new URL(value, "https://console.ivrm.jp");
    if (parsed.origin !== "https://console.ivrm.jp") {
      return "/";
    }
    if (
      parsed.pathname === "/login" ||
      parsed.pathname.startsWith("/api/auth/")
    ) {
      return "/";
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}

export function resolveDiscordConsoleRole(
  memberRoleIds: readonly string[],
  roleMap: Record<ConsoleRole, readonly string[]>,
): DiscordRoleResolution | null {
  const memberRoles = new Set(memberRoleIds);
  for (const consoleRole of DISCORD_ROLE_ORDER) {
    const matchedRoleIds = roleMap[consoleRole].filter((roleId) => memberRoles.has(roleId));
    if (matchedRoleIds.length > 0) {
      return { consoleRole, matchedRoleIds };
    }
  }
  return null;
}

type DiscordTokenResponse = {
  accessToken: string;
  tokenType: string;
};

function parseDiscordTokenResponse(value: unknown): DiscordTokenResponse {
  if (!isRecord(value)) {
    throw new DiscordAuthError("oauth_exchange_failed");
  }
  const accessToken = value.access_token;
  const tokenType = value.token_type;
  if (
    typeof accessToken !== "string" ||
    accessToken.length < 20 ||
    typeof tokenType !== "string" ||
    tokenType.toLowerCase() !== "bearer"
  ) {
    throw new DiscordAuthError("oauth_exchange_failed");
  }
  return { accessToken, tokenType };
}

export async function exchangeDiscordAuthorizationCode(
  code: string,
  configuration: DiscordAuthConfiguration,
): Promise<DiscordTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: configuration.redirectUri,
  });
  const basic = Buffer.from(
    `${configuration.clientId}:${configuration.clientSecret}`,
    "utf8",
  ).toString("base64");

  const response = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new DiscordAuthError("oauth_exchange_failed");
  }
  return parseDiscordTokenResponse((await response.json()) as unknown);
}

function parseDiscordUser(value: unknown): Omit<DiscordIdentity, "roleIds" | "pending"> {
  if (!isRecord(value)) {
    throw new DiscordAuthError("discord_identity_invalid");
  }
  if (
    typeof value.id !== "string" ||
    !SNOWFLAKE_PATTERN.test(value.id) ||
    typeof value.username !== "string" ||
    value.username.length < 1 ||
    value.username.length > 80 ||
    (value.global_name !== null && typeof value.global_name !== "string") ||
    (value.avatar !== null && typeof value.avatar !== "string")
  ) {
    throw new DiscordAuthError("discord_identity_invalid");
  }
  return {
    userId: value.id,
    username: value.username,
    globalName: value.global_name as string | null,
    avatarHash: value.avatar as string | null,
  };
}

function parseDiscordMember(value: unknown): { roleIds: string[]; pending: boolean } {
  if (!isRecord(value) || !Array.isArray(value.roles)) {
    throw new DiscordAuthError("discord_identity_invalid");
  }
  const roleIds: string[] = [];
  for (const roleId of value.roles) {
    if (typeof roleId !== "string" || !SNOWFLAKE_PATTERN.test(roleId)) {
      throw new DiscordAuthError("discord_identity_invalid");
    }
    roleIds.push(roleId);
  }
  return {
    roleIds,
    pending: value.pending === true,
  };
}

async function fetchDiscordJson(
  path: string,
  accessToken: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const body = response.status === 204 ? null : ((await response.json().catch(() => null)) as unknown);
  return { status: response.status, body };
}

export async function fetchDiscordIdentity(
  accessToken: string,
  configuration: DiscordAuthConfiguration,
): Promise<DiscordIdentity> {
  const [userResponse, memberResponse] = await Promise.all([
    fetchDiscordJson("/users/@me", accessToken),
    fetchDiscordJson(`/users/@me/guilds/${configuration.guildId}/member`, accessToken),
  ]);

  if (userResponse.status !== 200) {
    throw new DiscordAuthError("discord_identity_invalid");
  }
  if (memberResponse.status === 404 || memberResponse.status === 403) {
    throw new DiscordAuthError("guild_membership_required");
  }
  if (memberResponse.status !== 200) {
    throw new DiscordAuthError("discord_identity_invalid");
  }

  return {
    ...parseDiscordUser(userResponse.body),
    ...parseDiscordMember(memberResponse.body),
  };
}

export async function revokeDiscordAccessToken(
  accessToken: string,
  configuration: DiscordAuthConfiguration,
): Promise<void> {
  const body = new URLSearchParams({
    token: accessToken,
    token_type_hint: "access_token",
  });
  const basic = Buffer.from(
    `${configuration.clientId}:${configuration.clientSecret}`,
    "utf8",
  ).toString("base64");

  await fetch(`${DISCORD_API_BASE}/oauth2/token/revoke`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
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

function parseSessionRow(value: unknown): DiscordConsoleSessionRow | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.session_id !== "string" ||
    typeof value.discord_user_id !== "string" ||
    typeof value.discord_username !== "string" ||
    (value.discord_global_name !== null && typeof value.discord_global_name !== "string") ||
    (value.discord_avatar_hash !== null && typeof value.discord_avatar_hash !== "string") ||
    typeof value.guild_id !== "string" ||
    !Array.isArray(value.matched_role_ids) ||
    !value.matched_role_ids.every((roleId) => typeof roleId === "string") ||
    !isConsoleRole(value.console_role) ||
    typeof value.created_at !== "string" ||
    typeof value.expires_at !== "string"
  ) {
    return null;
  }
  return {
    sessionId: value.session_id,
    discordUserId: value.discord_user_id,
    discordUsername: value.discord_username,
    discordGlobalName: value.discord_global_name as string | null,
    discordAvatarHash: value.discord_avatar_hash as string | null,
    guildId: value.guild_id,
    matchedRoleIds: value.matched_role_ids as string[],
    consoleRole: value.console_role,
    createdAt: value.created_at,
    expiresAt: value.expires_at,
  };
}

export async function createDiscordConsoleSession(input: {
  requestId: string;
  identity: DiscordIdentity;
  resolution: DiscordRoleResolution;
  configuration: DiscordAuthConfiguration;
}): Promise<{ sessionToken: string; expiresAt: string }> {
  const sessionToken = generateOpaqueToken(32);
  const response = await callSupabaseRpc<unknown[]>("create_discord_console_session", {
    p_request_id: input.requestId,
    p_session_token_hash: hashOpaqueToken(sessionToken),
    p_discord_user_id: input.identity.userId,
    p_discord_username: input.identity.username,
    p_discord_global_name: input.identity.globalName,
    p_discord_avatar_hash: input.identity.avatarHash,
    p_guild_id: input.configuration.guildId,
    p_matched_role_ids: input.resolution.matchedRoleIds,
    p_console_role: input.resolution.consoleRole,
    p_ttl_seconds: input.configuration.sessionTtlSeconds,
  });

  if (!Array.isArray(response) || response.length !== 1 || !isRecord(response[0])) {
    throw new DiscordAuthError("session_create_failed");
  }
  const expiresAt = response[0].expires_at;
  if (typeof expiresAt !== "string") {
    throw new DiscordAuthError("session_create_failed");
  }
  return { sessionToken, expiresAt };
}

export async function resolveDiscordConsoleSession(
  sessionToken: string,
): Promise<DiscordConsoleSessionRow | null> {
  if (sessionToken.length < 32 || sessionToken.length > 256) {
    return null;
  }
  const response = await callSupabaseRpc<unknown[]>("resolve_discord_console_session", {
    p_session_token_hash: hashOpaqueToken(sessionToken),
  });
  if (!Array.isArray(response) || response.length > 1) {
    return null;
  }
  return response.length === 1 ? parseSessionRow(response[0]) : null;
}

export async function revokeDiscordConsoleSession(
  requestId: string,
  sessionToken: string,
): Promise<boolean> {
  if (sessionToken.length < 32 || sessionToken.length > 256) {
    return false;
  }
  return callSupabaseRpc<boolean>("revoke_discord_console_session", {
    p_request_id: requestId,
    p_session_token_hash: hashOpaqueToken(sessionToken),
    p_reason: "logout",
  });
}

export async function recordDiscordLoginDenied(input: {
  requestId: string;
  discordUserId: string | null;
  reason: DiscordLoginFailureReason;
  guildId: string | null;
}): Promise<void> {
  const targetId = input.discordUserId && SNOWFLAKE_PATTERN.test(input.discordUserId)
    ? input.discordUserId
    : "unknown";
  await callSupabaseRpc<unknown>("append_audit_log", {
    p_request_id: input.requestId,
    p_actor_user_id: null,
    p_actor_email: null,
    p_actor_role: null,
    p_actor_ip: null,
    p_action: "DISCORD_LOGIN_DENIED",
    p_target_type: "discord:user",
    p_target_id: targetId,
    p_result: "denied",
    p_metadata: {
      reason: input.reason,
      guildId: input.guildId,
    },
  }).catch(() => undefined);
}

export function discordAvatarUrl(
  userId: string | null,
  avatarHash: string | null,
): string | null {
  if (!userId || !avatarHash || !SNOWFLAKE_PATTERN.test(userId)) {
    return null;
  }
  const extension = avatarHash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${extension}?size=128`;
}

export function isSessionHash(value: string): boolean {
  return SESSION_HASH_PATTERN.test(value);
}
