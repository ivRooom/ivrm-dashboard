import { NextResponse, type NextRequest } from "next/server";
import {
  createDiscordAuthorizationUrl,
  generateOpaqueToken,
  getDiscordAuthConfiguration,
  sanitizeReturnPath,
} from "../../../../../lib/discord-auth";
import {
  encodeDiscordOAuthStateCookie,
  getDiscordOAuthCookieNames,
  getDiscordOAuthCookieNamesToPrune,
  MAX_DISCORD_OAUTH_ATTEMPTS,
} from "../../../../../lib/discord-oauth-cookies";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const COOKIE_BASE = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const configuration = getDiscordAuthConfiguration();
    if (!configuration) {
      return NextResponse.redirect(new URL("/login?error=auth_disabled", request.url));
    }

    const state = generateOpaqueToken(32);
    const cookieNames = getDiscordOAuthCookieNames(state);
    if (!cookieNames) {
      return NextResponse.redirect(new URL("/login?error=configuration_error", request.url));
    }

    const returnPath = sanitizeReturnPath(request.nextUrl.searchParams.get("returnTo"));
    const response = NextResponse.redirect(
      createDiscordAuthorizationUrl(configuration, state),
    );
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("X-Content-Type-Options", "nosniff");

    const staleCookieNames = getDiscordOAuthCookieNamesToPrune(
      request.cookies.getAll(),
      MAX_DISCORD_OAUTH_ATTEMPTS - 1,
    );
    for (const staleCookieName of staleCookieNames) {
      response.cookies.set(staleCookieName, "", {
        ...COOKIE_BASE,
        maxAge: 0,
      });
    }

    response.cookies.set(cookieNames.state, encodeDiscordOAuthStateCookie(state), {
      ...COOKIE_BASE,
      maxAge: 600,
    });
    response.cookies.set(cookieNames.returnTo, returnPath, {
      ...COOKIE_BASE,
      maxAge: 600,
    });
    return response;
  } catch {
    return NextResponse.redirect(new URL("/login?error=configuration_error", request.url));
  }
}
