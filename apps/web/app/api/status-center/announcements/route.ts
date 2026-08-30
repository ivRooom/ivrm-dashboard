import { NextResponse, type NextRequest } from "next/server";
import { getConsoleSession, hasConsoleRole } from "../../../../lib/console-auth";
import {
  archiveStatusAnnouncement,
  createStatusAnnouncement,
  publishStatusAnnouncement,
} from "../../../../lib/status-center-mutations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 16_384;
const JST_OFFSET_MS = 9 * 3_600_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_ID_PATTERN = /^ANN-[A-F0-9]{12}$/;
const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

type BodyReadResult =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "invalid" }
  | { kind: "too_large" };

type OptionalServices = string[] | null | "invalid";
type OptionalDateTime = string | null | "invalid";

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

async function readLimitedText(request: NextRequest): Promise<string | null | "too_large"> {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return "too_large";
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel("request_body_too_large").catch(() => undefined);
        return "too_large";
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function readBody(request: NextRequest): Promise<BodyReadResult> {
  const text = await readLimitedText(request);
  if (text === "too_large") return { kind: "too_large" };
  if (text === null) return { kind: "invalid" };

  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (contentType.includes("application/json")) {
    try {
      const body = JSON.parse(text) as unknown;
      return typeof body === "object" && body !== null && !Array.isArray(body)
        ? { kind: "ok", body: body as Record<string, unknown> }
        : { kind: "invalid" };
    } catch {
      return { kind: "invalid" };
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(text);
    return {
      kind: "ok",
      body: {
        action: form.get("action"),
        kind: form.get("kind"),
        title: form.get("title"),
        body: form.get("body"),
        serviceIds: form.get("serviceIds"),
        publishAt: form.get("publishAt"),
        expiresAt: form.get("expiresAt"),
        publicId: form.get("publicId"),
        idempotencyKey: form.get("idempotencyKey"),
        requestId: form.get("requestId"),
        acknowledged: form.has("acknowledged"),
      },
    };
  }

  return { kind: "invalid" };
}

function redirectResult(request: NextRequest, outcome: string, publicId?: string): NextResponse {
  const query = new URLSearchParams({ announcementMutation: outcome });
  if (publicId) query.set("announcement", publicId);
  return NextResponse.redirect(new URL(`/status-center?${query.toString()}#announcements`, request.url), 303);
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
  const timestamp = Date.UTC(year, month - 1, day, hour, minute) - JST_OFFSET_MS;
  const check = new Date(timestamp + JST_OFFSET_MS);
  if (
    check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute
  ) return null;
  return new Date(timestamp).toISOString();
}

function parseOptionalDateTime(value: unknown): OptionalDateTime {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !value.trim()) return null;
  return parseDateTime(value) ?? "invalid";
}

function parseOptionalServices(value: unknown): OptionalServices {
  if (value === null || value === undefined || value === "") return null;
  let values: unknown[];
  if (typeof value === "string") {
    if (value.length > 2_100) return "invalid";
    const text = value.trim();
    if (!text) return null;
    values = text.split(",").map((item) => item.trim()).filter(Boolean);
  } else if (Array.isArray(value)) {
    values = value;
  } else {
    return "invalid";
  }
  if (values.length < 1 || values.length > 32) return "invalid";
  const ids: string[] = [];
  for (const valueItem of values) {
    if (typeof valueItem !== "string") return "invalid";
    const id = valueItem.trim();
    if (!SERVICE_ID_PATTERN.test(id)) return "invalid";
    ids.push(id);
  }
  return new Set(ids).size === ids.length ? ids : "invalid";
}

function acknowledged(value: unknown): boolean {
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
    console.error("Status Center Session取得に失敗しました", error);
    return jsonResponse({ error: "session_unavailable" }, 503);
  }

  const actorRole = session.role;
  if (
    !hasConsoleRole(session, "administrator") ||
    (actorRole !== "administrator" && actorRole !== "owner")
  ) {
    return jsonResponse({ error: "administrator_role_required" }, 403);
  }

  const bodyResult = await readBody(request);
  if (bodyResult.kind === "too_large") return jsonResponse({ error: "request_body_too_large" }, 413);
  if (bodyResult.kind === "invalid") return jsonResponse({ error: "request_body_invalid" }, 400);
  const body = bodyResult.body;
  const action = body.action;

  if (action === "create") {
    const kind = body.kind === "info" || body.kind === "warning" ? body.kind : null;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const publicBody = typeof body.body === "string" ? body.body.trim() : "";
    const affectedServiceIds = parseOptionalServices(body.serviceIds);
    const publishAt = parseDateTime(body.publishAt);
    const expiresAt = parseOptionalDateTime(body.expiresAt);
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    if (
      !kind || title.length < 1 || title.length > 160 ||
      publicBody.length < 1 || publicBody.length > 4_000 ||
      affectedServiceIds === "invalid" || !publishAt || expiresAt === "invalid" ||
      !UUID_PATTERN.test(idempotencyKey)
    ) {
      return wantsJson(request)
        ? jsonResponse({ error: "announcement_create_input_invalid" }, 400)
        : redirectResult(request, "create_invalid");
    }
    if (expiresAt && Date.parse(expiresAt) <= Date.parse(publishAt)) {
      return wantsJson(request)
        ? jsonResponse({ error: "announcement_schedule_invalid" }, 400)
        : redirectResult(request, "create_invalid");
    }
    try {
      const announcement = await createStatusAnnouncement({
        kind,
        title,
        body: publicBody,
        affectedServiceIds,
        publishAt,
        expiresAt,
        idempotencyKey,
        actorEmail: session.email,
        actorDiscordUserId: session.discordUserId,
        actorRole,
      });
      return wantsJson(request)
        ? jsonResponse({ announcement }, 201)
        : redirectResult(request, "created", announcement.publicId);
    } catch (error) {
      console.error("Status Announcement作成に失敗しました", error);
      return wantsJson(request)
        ? jsonResponse({ error: "announcement_create_failed" }, 503)
        : redirectResult(request, "mutation_failed");
    }
  }

  const publicId = typeof body.publicId === "string" ? body.publicId.trim() : "";
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  if (!PUBLIC_ID_PATTERN.test(publicId) || !UUID_PATTERN.test(requestId)) {
    return wantsJson(request)
      ? jsonResponse({ error: "announcement_identity_invalid" }, 400)
      : redirectResult(request, "identity_invalid");
  }

  if (action === "publish") {
    if (!acknowledged(body.acknowledged)) {
      return wantsJson(request)
        ? jsonResponse({ error: "announcement_publish_acknowledgement_required" }, 400)
        : redirectResult(request, "acknowledgement_required", publicId);
    }
    try {
      const announcement = await publishStatusAnnouncement({
        publicId,
        requestId,
        actorEmail: session.email,
        actorDiscordUserId: session.discordUserId,
        actorRole,
      });
      return wantsJson(request)
        ? jsonResponse({ announcement })
        : redirectResult(request, "published", announcement.publicId);
    } catch (error) {
      console.error("Status Announcement公開に失敗しました", error);
      return wantsJson(request)
        ? jsonResponse({ error: "announcement_publish_failed" }, 503)
        : redirectResult(request, "mutation_failed", publicId);
    }
  }

  if (action === "archive") {
    if (!acknowledged(body.acknowledged)) {
      return wantsJson(request)
        ? jsonResponse({ error: "announcement_archive_acknowledgement_required" }, 400)
        : redirectResult(request, "acknowledgement_required", publicId);
    }
    try {
      const announcement = await archiveStatusAnnouncement({
        publicId,
        requestId,
        actorEmail: session.email,
        actorDiscordUserId: session.discordUserId,
        actorRole,
      });
      return wantsJson(request)
        ? jsonResponse({ announcement })
        : redirectResult(request, "archived", announcement.publicId);
    } catch (error) {
      console.error("Status Announcement Archiveに失敗しました", error);
      return wantsJson(request)
        ? jsonResponse({ error: "announcement_archive_failed" }, 503)
        : redirectResult(request, "mutation_failed", publicId);
    }
  }

  return jsonResponse({ error: "action_invalid" }, 400);
}
