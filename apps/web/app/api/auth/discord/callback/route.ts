import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  DISCORD_OAUTH_RETURN_COOKIE,
  DISCORD_OAUTH_STATE_COOKIE,
  DISCORD_SESSION_COOKIE,
  DiscordAuthError,
  consumeDiscordOAuthState,
  createDiscordConsoleSession,
  exchangeDiscordAuthorizationCode,
  fetchDiscordIdentity,
  getDiscordAuthConfiguration,
  matchesDiscordOAuthState,
  recordDiscordLoginDenied,
  resolveDiscordConsoleRole,
  revokeDiscordAccessToken,
  sanitizeDiscordOAuthProviderError,
  sanitizeReturnPath,
  type DiscordAuthConfiguration,
  type DiscordLoginFailureReason,
} from "../../../../../lib/discord-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const COOKIE_BASE = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
};

function updateOAuthCookies(
  response: NextResponse,
  remainingState: string | null,
): void {
  if (remainingState) {
    response.cookies.set(DISCORD_OAUTH_STATE_COOKIE, remainingState, {
      ...COOKIE_BASE,
      maxAge: 600,
    });
  } else {
    response.cookies.set(DISCORD_OAUTH_STATE_COOKIE, "", {
      ...COOKIE_BASE,
      maxAge: 0,
    });
  }
  response.cookies.set(DISCORD_OAUTH_RETURN_COOKIE, "", {
    ...COOKIE_BASE,
    maxAge: 0,
  });
}

function loginErrorResponse(
  request: NextRequest,
  reason: DiscordLoginFailureReason,
  options: {
    remainingState?: string | null;
    preserveOAuthCookies?: boolean;
  } = {},
): NextResponse {
  const response = NextResponse.redirect(
    new URL(`/login?error=${encodeURIComponent(reason)}`, request.url),
  );
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("X-Content-Type-Options", "nosniff");
  if (!options.preserveOAuthCookies) {
    updateOAuthCookies(response, options.remainingState ?? null);
  }
  return response;
}

function reasonFromError(error: unknown): DiscordLoginFailureReason {
  if (error instanceof DiscordAuthError) {
    return error.reason;
  }
  return "configuration_error";
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const returnedState = request.nextUrl.searchParams.get("state");
  const stateCookie = request.cookies.get(DISCORD_OAUTH_STATE_COOKIE)?.value || null;
  const returnPath = sanitizeReturnPath(
    request.cookies.get(DISCORD_OAUTH_RETURN_COOKIE)?.value || null,
  );
  let discordUserId: string | null = null;
  let guildId: string | null = null;
  let accessToken: string | null = null;
  let configuration: DiscordAuthConfiguration | null = null;

  if (!returnedState || !matchesDiscordOAuthState(returnedState, stateCookie)) {
    await recordDiscordLoginDenied({
      requestId,
      discordUserId: null,
      reason: "oauth_state_invalid",
      guildId: null,
    });
    return loginErrorResponse(request, "oauth_state_invalid", {
      preserveOAuthCookies: true,
    });
  }

  const remainingState = consumeDiscordOAuthState(returnedState, stateCookie);
  const oauthError = sanitizeDiscordOAuthProviderError(
    request.nextUrl.searchParams.get("error"),
  );
  if (oauthError) {
    const reason: DiscordLoginFailureReason =
      oauthError === "access_denied" ? "oauth_denied" : "oauth_provider_error";
    await recordDiscordLoginDenied({
      requestId,
      discordUserId: null,
      reason,
      guildId: null,
      providerError: oauthError,
    });
    return loginErrorResponse(request, reason, { remainingState });
  }

  const code = request.nextUrl.searchParams.get("code");
  if (!code || code.length > 4096) {
    await recordDiscordLoginDenied({
      requestId,
      discordUserId: null,
      reason: "oauth_code_missing",
      guildId: null,
    });
    return loginErrorResponse(request, "oauth_code_missing", { remainingState });
  }

  try {
    configuration = getDiscordAuthConfiguration();
    if (!configuration) {
      throw new DiscordAuthError("configuration_error");
    }
    guildId = configuration.guildId;

    const token = await exchangeDiscordAuthorizationCode(code, configuration);
    accessToken = token.accessToken;

    const identity = await fetchDiscordIdentity(accessToken, configuration);
    discordUserId = identity.userId;
    if (identity.pending) {
      throw new DiscordAuthError("membership_screening_pending");
    }

    const resolution = resolveDiscordConsoleRole(identity.roleIds, configuration.roleMap);
    if (!resolution) {
      throw new DiscordAuthError("required_role_missing");
    }

    const session = await createDiscordConsoleSession({
      requestId,
      identity,
      resolution,
      configuration,
    });
    const expiresAt = new Date(session.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new DiscordAuthError("session_create_failed");
    }

    const response = NextResponse.redirect(new URL(returnPath, request.url));
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.cookies.set(DISCORD_SESSION_COOKIE, session.sessionToken, {
      ...COOKIE_BASE,
      expires: expiresAt,
    });
    updateOAuthCookies(response, remainingState);
    return response;
  } catch (error) {
    const reason = reasonFromError(error);
    await recordDiscordLoginDenied({
      requestId,
      discordUserId,
      reason,
      guildId,
    });
    return loginErrorResponse(request, reason, { remainingState });
  } finally {
    if (accessToken && configuration) {
      await revokeDiscordAccessToken(accessToken, configuration).catch(() => undefined);
    }
  }
}
