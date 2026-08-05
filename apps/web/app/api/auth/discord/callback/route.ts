import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  DISCORD_OAUTH_RETURN_COOKIE,
  DISCORD_OAUTH_STATE_COOKIE,
  DISCORD_SESSION_COOKIE,
  DiscordAuthError,
  constantTimeEqual,
  createDiscordConsoleSession,
  exchangeDiscordAuthorizationCode,
  fetchDiscordIdentity,
  getDiscordAuthConfiguration,
  recordDiscordLoginDenied,
  resolveDiscordConsoleRole,
  revokeDiscordAccessToken,
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

function clearOAuthCookies(response: NextResponse): void {
  response.cookies.set(DISCORD_OAUTH_STATE_COOKIE, "", {
    ...COOKIE_BASE,
    maxAge: 0,
  });
  response.cookies.set(DISCORD_OAUTH_RETURN_COOKIE, "", {
    ...COOKIE_BASE,
    maxAge: 0,
  });
}

function loginErrorResponse(
  request: NextRequest,
  reason: DiscordLoginFailureReason,
): NextResponse {
  const response = NextResponse.redirect(
    new URL(`/login?error=${encodeURIComponent(reason)}`, request.url),
  );
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("X-Content-Type-Options", "nosniff");
  clearOAuthCookies(response);
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
  const expectedState = request.cookies.get(DISCORD_OAUTH_STATE_COOKIE)?.value || null;
  const returnPath = sanitizeReturnPath(
    request.cookies.get(DISCORD_OAUTH_RETURN_COOKIE)?.value || null,
  );
  const oauthError = request.nextUrl.searchParams.get("error");
  let discordUserId: string | null = null;
  let guildId: string | null = null;
  let accessToken: string | null = null;
  let configuration: DiscordAuthConfiguration | null = null;

  if (oauthError) {
    await recordDiscordLoginDenied({
      requestId,
      discordUserId: null,
      reason: "oauth_denied",
      guildId: null,
    });
    return loginErrorResponse(request, "oauth_denied");
  }

  if (
    !returnedState ||
    !expectedState ||
    !constantTimeEqual(returnedState, expectedState)
  ) {
    await recordDiscordLoginDenied({
      requestId,
      discordUserId: null,
      reason: "oauth_state_invalid",
      guildId: null,
    });
    return loginErrorResponse(request, "oauth_state_invalid");
  }

  const code = request.nextUrl.searchParams.get("code");
  if (!code || code.length > 4096) {
    await recordDiscordLoginDenied({
      requestId,
      discordUserId: null,
      reason: "oauth_code_missing",
      guildId: null,
    });
    return loginErrorResponse(request, "oauth_code_missing");
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
    clearOAuthCookies(response);
    return response;
  } catch (error) {
    const reason = reasonFromError(error);
    await recordDiscordLoginDenied({
      requestId,
      discordUserId,
      reason,
      guildId,
    });
    return loginErrorResponse(request, reason);
  } finally {
    if (accessToken && configuration) {
      await revokeDiscordAccessToken(accessToken, configuration).catch(() => undefined);
    }
  }
}
