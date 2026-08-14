import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getConsoleSession, hasConsoleRole } from "../../../../lib/console-auth";
import {
  cancelReliabilityMaintenanceWindow,
  createReliabilityMaintenanceWindow,
} from "../../../../lib/reliability-maintenance";
import type {
  ReliabilityMaintenanceScopeType,
  ReliabilitySloServiceId,
} from "../../../../lib/reliability";
import { parseIncidentRange } from "../../../../lib/unified-incidents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SERVICE_IDS = new Set<ReliabilitySloServiceId>([
  "overall",
  "host",
  "container",
  "backup",
]);
const SCOPE_TYPES = new Set<ReliabilityMaintenanceScopeType>([
  "service",
  "host",
  "container",
  "backup",
]);
const BACKUP_TYPES = new Set(["world", "config", "permissions", "full"] as const);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTAINER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_BODY_BYTES = 8_192;
const MAX_DURATION_MS = 7 * 86_400_000;
const JST_OFFSET_MS = 9 * 3_600_000;

type Target = {
  serviceId: ReliabilitySloServiceId | null;
  hostId: string | null;
  containerName: string | null;
  backupTarget: string | null;
  gameMode: string | null;
  backupType: "world" | "config" | "permissions" | "full" | null;
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

function wantsJson(request: NextRequest): boolean {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}

async function readBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return null;

  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as unknown;
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  }
  const form = await request.formData().catch(() => null);
  if (!form) return null;
  return {
    action: form.get("action"),
    scopeType: form.get("scopeType"),
    targetKey: form.get("targetKey"),
    startsAt: form.get("startsAt"),
    endsAt: form.get("endsAt"),
    reason: form.get("reason"),
    acknowledged: form.has("acknowledged"),
    windowId: form.get("windowId"),
    range: form.get("range"),
  };
}

function redirectResult(request: NextRequest, range: string, outcome: string): NextResponse {
  return NextResponse.redirect(
    new URL(
      `/reliability?range=${encodeURIComponent(range)}&maintenance=${encodeURIComponent(outcome)}#maintenance-windows`,
      request.url,
    ),
    303,
  );
}

function parseScope(value: unknown): ReliabilityMaintenanceScopeType | null {
  return typeof value === "string" && SCOPE_TYPES.has(value as ReliabilityMaintenanceScopeType)
    ? (value as ReliabilityMaintenanceScopeType)
    : null;
}

function parseTarget(scopeType: ReliabilityMaintenanceScopeType, value: unknown): Target | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 400) return null;
  const parts = value.split("/");

  if (scopeType === "service") {
    if (parts.length !== 1 || !SERVICE_IDS.has(value as ReliabilitySloServiceId)) return null;
    return {
      serviceId: value as ReliabilitySloServiceId,
      hostId: null,
      containerName: null,
      backupTarget: null,
      gameMode: null,
      backupType: null,
    };
  }

  if (scopeType === "host") {
    if (parts.length !== 1 || !UUID_PATTERN.test(value)) return null;
    return {
      serviceId: null,
      hostId: value,
      containerName: null,
      backupTarget: null,
      gameMode: null,
      backupType: null,
    };
  }

  if (scopeType === "container") {
    if (
      parts.length !== 2 ||
      !UUID_PATTERN.test(parts[0] ?? "") ||
      !CONTAINER_PATTERN.test(parts[1] ?? "")
    ) return null;
    return {
      serviceId: null,
      hostId: parts[0] ?? null,
      containerName: parts[1] ?? null,
      backupTarget: null,
      gameMode: null,
      backupType: null,
    };
  }

  if (
    parts.length !== 4 ||
    !UUID_PATTERN.test(parts[0] ?? "") ||
    !TARGET_PATTERN.test(parts[1] ?? "") ||
    !TARGET_PATTERN.test(parts[2] ?? "") ||
    !BACKUP_TYPES.has(parts[3] as "world" | "config" | "permissions" | "full")
  ) return null;
  return {
    serviceId: null,
    hostId: parts[0] ?? null,
    containerName: null,
    backupTarget: parts[1] ?? null,
    gameMode: parts[2] ?? null,
    backupType: parts[3] as "world" | "config" | "permissions" | "full",
  };
}

function parseDateTime(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const text = value.trim();
  if (/Z$|[+-]\d{2}:\d{2}$/.test(text)) {
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (
    month < 1 || month > 12 || day < 1 || day > 31 ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59
  ) return null;

  const timestamp = Date.UTC(year, month - 1, day, hour, minute) - JST_OFFSET_MS;
  const check = new Date(timestamp + JST_OFFSET_MS);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) return null;
  return new Date(timestamp).toISOString();
}

function acknowledgement(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === "on";
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) {
    return jsonResponse({ error: "origin_mismatch" }, 403);
  }

  let session: Awaited<ReturnType<typeof getConsoleSession>>;
  try {
    session = await getConsoleSession();
  } catch (error) {
    console.error("Reliability Maintenance Session取得に失敗しました", error);
    return jsonResponse({ error: "session_unavailable" }, 503);
  }

  const actorRole = session.role;
  if (
    !hasConsoleRole(session, "administrator") ||
    (actorRole !== "administrator" && actorRole !== "owner")
  ) {
    return jsonResponse({ error: "administrator_role_required" }, 403);
  }

  const body = await readBody(request);
  if (!body) return jsonResponse({ error: "request_body_invalid" }, 400);
  const range = parseIncidentRange(typeof body.range === "string" ? body.range : null);
  const action = body.action;

  if (action === "cancel") {
    const windowId = typeof body.windowId === "string" ? body.windowId : "";
    if (!UUID_PATTERN.test(windowId)) {
      return wantsJson(request)
        ? jsonResponse({ error: "window_id_invalid" }, 400)
        : redirectResult(request, range, "window_invalid");
    }
    try {
      const window = await cancelReliabilityMaintenanceWindow({
        windowId,
        requestId: randomUUID(),
        actorEmail: session.email,
        actorDiscordUserId: session.discordUserId,
        actorRole,
      });
      return wantsJson(request)
        ? jsonResponse({ window })
        : redirectResult(request, range, "cancelled");
    } catch (error) {
      console.error("Reliability Maintenance Window取消に失敗しました", error);
      return wantsJson(request)
        ? jsonResponse({ error: "maintenance_cancel_failed" }, 503)
        : redirectResult(request, range, "mutation_failed");
    }
  }

  if (action !== "create") {
    return jsonResponse({ error: "action_invalid" }, 400);
  }

  const scopeType = parseScope(body.scopeType);
  const target = scopeType ? parseTarget(scopeType, body.targetKey) : null;
  const startsAt = parseDateTime(body.startsAt);
  const endsAt = parseDateTime(body.endsAt);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  if (!scopeType || !target) {
    return wantsJson(request)
      ? jsonResponse({ error: "maintenance_target_invalid" }, 400)
      : redirectResult(request, range, "target_invalid");
  }
  if (!acknowledgement(body.acknowledged)) {
    return wantsJson(request)
      ? jsonResponse({ error: "maintenance_acknowledgement_required" }, 400)
      : redirectResult(request, range, "acknowledgement_required");
  }
  if (!startsAt || !endsAt) {
    return wantsJson(request)
      ? jsonResponse({ error: "maintenance_time_invalid" }, 400)
      : redirectResult(request, range, "time_invalid");
  }

  const startMs = Date.parse(startsAt);
  const endMs = Date.parse(endsAt);
  const now = Date.now();
  if (
    endMs <= startMs ||
    endMs - startMs > MAX_DURATION_MS ||
    startMs < now - 5 * 60_000 ||
    startMs > now + 365 * 86_400_000
  ) {
    return wantsJson(request)
      ? jsonResponse({ error: "maintenance_time_invalid" }, 400)
      : redirectResult(request, range, "time_invalid");
  }
  if (reason.length < 1 || reason.length > 200) {
    return wantsJson(request)
      ? jsonResponse({ error: "maintenance_reason_invalid" }, 400)
      : redirectResult(request, range, "reason_invalid");
  }

  try {
    const window = await createReliabilityMaintenanceWindow({
      scopeType,
      ...target,
      startsAt,
      endsAt,
      reason,
      requestId: randomUUID(),
      actorEmail: session.email,
      actorDiscordUserId: session.discordUserId,
      actorRole,
    });
    return wantsJson(request)
      ? jsonResponse({ window }, 201)
      : redirectResult(request, range, "created");
  } catch (error) {
    console.error("Reliability Maintenance Window作成に失敗しました", error);
    return wantsJson(request)
      ? jsonResponse({ error: "maintenance_create_failed" }, 503)
      : redirectResult(request, range, "mutation_failed");
  }
}
