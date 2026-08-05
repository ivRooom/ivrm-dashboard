import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getConsoleSession, hasConsoleRole } from "../../../../../../lib/console-auth";
import { DISCORD_SESSION_COOKIE } from "../../../../../../lib/discord-auth";
import {
  parseUuid,
  revokeDiscordConsoleSessionById,
} from "../../../../../../lib/discord-security-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function jsonResponse(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(DISCORD_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

async function readConfirmation(request: NextRequest): Promise<string | null> {
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return null;
    }
    const value = (body as Record<string, unknown>).confirmation;
    return typeof value === "string" ? value : null;
  }

  const form = await request.formData().catch(() => null);
  const value = form?.get("confirmation");
  return typeof value === "string" ? value : null;
}

function wantsJson(request: NextRequest): boolean {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) {
    return jsonResponse({ error: "origin_mismatch" }, 403);
  }

  const session = await getConsoleSession();
  if (!hasConsoleRole(session, "administrator")) {
    return jsonResponse({ error: "administrator_role_required" }, 403);
  }

  const { id } = await context.params;
  const targetSessionId = parseUuid(id);
  if (!targetSessionId) {
    return jsonResponse({ error: "session_id_invalid" }, 400);
  }

  const confirmation = await readConfirmation(request);
  if (confirmation !== "REVOKE") {
    return jsonResponse({ error: "confirmation_required" }, 400);
  }

  const cookieStore = await cookies();
  const actorSessionToken = cookieStore.get(DISCORD_SESSION_COOKIE)?.value || null;
  if (!actorSessionToken) {
    return jsonResponse({ error: "discord_session_required" }, 401);
  }

  try {
    const result = await revokeDiscordConsoleSessionById({
      requestId: randomUUID(),
      actorSessionToken,
      targetSessionId,
    });

    if (result.outcome === "denied") {
      return jsonResponse({ error: "owner_session_protected" }, 403);
    }
    if (result.outcome === "not_found") {
      return jsonResponse({ error: "session_not_found" }, 404);
    }

    if (wantsJson(request)) {
      const response = jsonResponse({
        outcome: result.outcome,
        targetWasCurrent: result.targetWasCurrent,
      });
      if (result.targetWasCurrent) {
        clearSessionCookie(response);
      }
      return response;
    }

    if (result.targetWasCurrent) {
      const response = NextResponse.redirect(
        new URL("/login?loggedOut=1", request.url),
        303,
      );
      response.headers.set("Cache-Control", "private, no-store, max-age=0");
      clearSessionCookie(response);
      return response;
    }

    return NextResponse.redirect(
      new URL(`/security/sessions?outcome=${encodeURIComponent(result.outcome)}`, request.url),
      303,
    );
  } catch {
    return jsonResponse({ error: "discord_session_revoke_failed" }, 503);
  }
}
