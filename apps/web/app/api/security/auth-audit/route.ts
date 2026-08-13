import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getConsoleSession, hasConsoleRole } from "../../../../lib/console-auth";
import { DISCORD_SESSION_COOKIE } from "../../../../lib/discord-auth";
import {
  listDiscordAuthAuditLogs,
  parseAuditResult,
  parseDiscordAuditAction,
  parsePositiveInteger,
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

  const actionRaw = request.nextUrl.searchParams.get("action");
  const resultRaw = request.nextUrl.searchParams.get("result");
  const action = actionRaw ? parseDiscordAuditAction(actionRaw) : null;
  const result = resultRaw ? parseAuditResult(resultRaw) : null;
  if (actionRaw && !action) {
    return errorResponse("action_filter_invalid", 400);
  }
  if (resultRaw && !result) {
    return errorResponse("result_filter_invalid", 400);
  }

  const beforeOccurredAt = parseCursorDate(
    request.nextUrl.searchParams.get("beforeOccurredAt"),
  );
  const beforeId = parsePositiveInteger(request.nextUrl.searchParams.get("beforeId"));
  if ((beforeOccurredAt === null) !== (beforeId === null)) {
    return errorResponse("cursor_invalid", 400);
  }

  try {
    const logs = await listDiscordAuthAuditLogs({
      actorSessionToken,
      action,
      result,
      limit: 50,
      beforeOccurredAt,
      beforeId,
    });
    const last = logs.at(-1) ?? null;

    return NextResponse.json(
      {
        logs,
        nextCursor:
          logs.length === 50 && last
            ? {
                beforeOccurredAt: last.occurredAt,
                beforeId: last.auditId,
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
    return errorResponse("discord_auth_audit_list_failed", 503);
  }
}
