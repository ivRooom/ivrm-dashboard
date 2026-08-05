import { NextResponse, type NextRequest } from "next/server";
import {
  DISCORD_OAUTH_RETURN_COOKIE,
  DISCORD_OAUTH_STATE_COOKIE,
  createDiscordAuthorizationUrl,
  generateOpaqueToken,
  getDiscordAuthConfiguration,
  sanitizeReturnPath,
} from "../../../../../lib/discord-auth";

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
    const returnPath = sanitizeReturnPath(request.nextUrl.searchParams.get("returnTo"));
    const response = NextResponse.redirect(
      createDiscordAuthorizationUrl(configuration, state),
    );
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.cookies.set(DISCORD_OAUTH_STATE_COOKIE, state, {
      ...COOKIE_BASE,
      maxAge: 600,
    });
    response.cookies.set(DISCORD_OAUTH_RETURN_COOKIE, returnPath, {
      ...COOKIE_BASE,
      maxAge: 600,
    });
    return response;
  } catch {
    return NextResponse.redirect(new URL("/login?error=configuration_error", request.url));
  }
}
