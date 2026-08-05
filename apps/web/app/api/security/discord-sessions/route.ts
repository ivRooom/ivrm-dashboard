import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getConsoleSession, hasConsoleRole } from "../../../../lib/console-auth";
import { DISCORD_SESSION_COOKIE } from "../../../../lib/discord-auth";
import {
  listDiscordConsoleSessions,
  parseDiscordSessionStatus,
  parseUuid,
} from "../../../../lib/discord-security-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(code: string, status: number): NextResponse {
  return NextResponse.json(
    { error: code },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function parseCursorDate(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getConsoleSession();
  if (!hasConsoleRole(session, "administrator")) {
    return errorResponse("administrator_role_required", 403);
  }

  const cookieStore = await cookies();
  const actorSessionToken = cookieStore.get(DISCORD_SESSION_COOKIE)?.value || null;
  if (!actorSessionToken) {
    return errorResponse("discord_session_required", 401);
  }

  const status = parseDiscordSessionStatus(request.nextUrl.searchParams.get("status"));
  const beforeCreatedAt = parseCursorDate(
    request.nextUrl.searchParams.get("beforeCreatedAt"),
  );
  const beforeId = parseUuid(request.nextUrl.searchParams.get("beforeId"));
  if ((beforeCreatedAt === null) !== (beforeId === null)) {
    return errorResponse("cursor_invalid", 400);
  }

  try {
    const sessions = await listDiscordConsoleSessions({
      actorSessionToken,
      status,
      limit: 50,
      beforeCreatedAt,
      beforeId,
    });
    const last = sessions.at(-1) ?? null;

    return NextResponse.json(
      {
        sessions,
        nextCursor:
          sessions.length === 50 && last
            ? {
                beforeCreatedAt: last.createdAt,
                beforeId: last.sessionId,
              }
            : null,
      },
      {
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch {
    return errorResponse("discord_session_list_failed", 503);
  }
}
