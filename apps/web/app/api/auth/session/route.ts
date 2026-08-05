import { NextResponse } from "next/server";
import { getConsoleSession } from "../../../../lib/console-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getConsoleSession();
  return NextResponse.json(
    {
      authProvider: session.authProvider,
      status: session.status,
      role: session.role,
      displayName: session.displayName,
      email: session.email,
      discord: {
        mode: session.discordMode,
        userId: session.discordUserId,
        username: session.discordUsername,
        avatarUrl: session.discordAvatarUrl,
        matchedRoleCount: session.matchedDiscordRoleIds.length,
        sessionExpiresAt: session.sessionExpiresAt,
      },
      cloudflareAccess: {
        mode: session.mode,
        state: session.accessState,
      },
    },
    {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
