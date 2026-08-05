import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  DISCORD_SESSION_COOKIE,
  revokeDiscordConsoleSession,
} from "../../../../lib/discord-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json(
      { error: "origin_mismatch" },
      {
        status: 403,
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }

  const sessionToken = request.cookies.get(DISCORD_SESSION_COOKIE)?.value || null;
  if (sessionToken) {
    await revokeDiscordConsoleSession(randomUUID(), sessionToken).catch(() => false);
  }

  const response = NextResponse.redirect(new URL("/login?loggedOut=1", request.url), 303);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.cookies.set(DISCORD_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
