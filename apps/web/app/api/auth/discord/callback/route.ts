import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  DISCORD_SESSION_COOKIE,
  DiscordAuthError,
  createDiscordConsoleSession,
  exchangeDiscordAuthorizationCode,
  fetchDiscordIdentity,
  getDiscordAuthConfiguration,
  recordDiscordLoginDenied,
  resolveDiscordConsoleRole,
  revokeDiscordAccessToken,
  sanitizeDiscordOAuthProviderError,
  type DiscordAuthConfiguration,
  type DiscordLoginFailureReason,
} from "../../../../../lib/discord-auth";
import {
  getDiscordOAuthSlotCookieName,
  verifyDiscordOAuthAttempt,
} from "../../../../../lib/discord-oauth-cookies";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const COOKIE_BASE = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
};

function loginErrorResponse(
  request: NextRequest,
  reason: DiscordLoginFailureReason,
): NextResponse {
  const response = NextResponse.redirect(
    new URL(`/login?error=${encodeURIComponent(reason)}`, request.url),
  );
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("X-Content-Type-Options", "nosniff");
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
  let discordUserId: string | null = null;
  let guildId: string | null = null;
  let accessToken: string | null = null;
  let configuration: DiscordAuthConfiguration | null = null;

  try {
    configuration = getDiscordAuthConfiguration();
  } catch {
    await recordDiscordLoginDenied({
      requestId,
      discordUserId: null,
      reason: "configuration_error",
      guildId: null,
    });
    return loginErrorResponse(request, "configuration_error");
  }

  if (!configuration) {
    await recordDiscordLoginDenied({
      requestId,
      discordUserId: null,
      reason: "configuration_error",
      guildId: null,
    });
    return loginErrorResponse(request, "configuration_error");
  }
  guildId = configuration.guildId;

  const cookieName = getDiscordOAuthSlotCookieName(returnedState);
  const cookieValue = cookieName
    ? request.cookies.get(cookieName)?.value || null
    : null;
  const attempt = verifyDiscordOAuthAttempt(
    returnedState,
    cookieValue,
    configuration.clientSecret,
  );

  if (!cookieName || !attempt) {
    await recordDiscordLoginDenied({
      requestId,
      discordUserId: null,
      reason: "oauth_state_invalid",
      guildId,
    });
    return loginErrorResponse(request, "oauth_state_invalid");
  }

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
      guildId,
      providerError: oauthError,
    });
    return loginErrorResponse(request, reason);
  }

  const code = request.nextUrl.searchParams.get("code");
  if (!code || code.length > 4096) {
    await recordDiscordLoginDenied({
      requestId,
      discordUserId: null,
      reason: "oauth_code_missing",
      guildId,
    });
    return loginErrorResponse(request, "oauth_code_missing");
  }

  try {
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

    const response = NextResponse.redirect(new URL(attempt.returnTo, request.url));
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.cookies.set(DISCORD_SESSION_COOKIE, session.sessionToken, {
      ...COOKIE_BASE,
      expires: expiresAt,
    });
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
    if (accessToken) {
      await revokeDiscordAccessToken(accessToken, configuration).catch(() => undefined);
    }
  }
}
