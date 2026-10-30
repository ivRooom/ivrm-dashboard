import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getConsoleSession, hasConsoleRole } from "../../../../lib/console-auth";
import { DISCORD_SESSION_COOKIE } from "../../../../lib/discord-auth";
import {
  listDiscordAuthAuditLogs,
  parsePositiveInteger,
} from "../../../../lib/discord-security-admin";
import { projectDiscordAuthAuditEvent } from "../../../../lib/security-event-projection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Vary": "Cookie",
  "X-Content-Type-Options": "nosniff",
};

function errorResponse(code: string, status: number): NextResponse {
  return NextResponse.json({ error: code }, { status, headers: RESPONSE_HEADERS });
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

  const beforeOccurredAtRaw = request.nextUrl.searchParams.get("beforeOccurredAt");
  const beforeIdRaw = request.nextUrl.searchParams.get("beforeId");
  const beforeId = parsePositiveInteger(beforeIdRaw);
  const beforeTimestamp = beforeOccurredAtRaw ? Date.parse(beforeOccurredAtRaw) : NaN;
  const beforeOccurredAt = Number.isFinite(beforeTimestamp)
    ? beforeOccurredAtRaw
    : null;
  if (
    (beforeOccurredAtRaw !== null && !beforeOccurredAt) ||
    (beforeIdRaw !== null && beforeId === null) ||
    (beforeOccurredAt === null) !== (beforeId === null)
  ) {
    return errorResponse("cursor_invalid", 400);
  }

  try {
    const rows = await listDiscordAuthAuditLogs({
      actorSessionToken,
      limit: 50,
      beforeOccurredAt,
      beforeId,
    });
    const last = rows.at(-1) ?? null;
    return NextResponse.json(
      {
        events: rows.map(projectDiscordAuthAuditEvent),
        nextCursor:
          rows.length === 50 && last
            ? { beforeOccurredAt: last.occurredAt, beforeId: last.auditId }
            : null,
        coverage: {
          source: "discord-auth-audit",
          scope: "existing-auth-audit-only",
          correlation: "not-connected",
          automaticBlocking: false,
        },
      },
      { headers: RESPONSE_HEADERS },
    );
  } catch {
    return errorResponse("security_events_unavailable", 503);
  }
}
