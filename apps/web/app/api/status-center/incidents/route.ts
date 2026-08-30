import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getConsoleSession, hasConsoleRole } from "../../../../lib/console-auth";
import {
  createStatusIncident,
  publishStatusIncident,
  updateStatusIncident,
} from "../../../../lib/status-center-mutations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 12_288;
const JST_OFFSET_MS = 9 * 3_600_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_ID_PATTERN = /^INC-[A-F0-9]{12}$/;
const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const IMPACTS = new Set(["none", "minor", "major", "critical"]);
const LIFECYCLE = new Set(["investigating", "identified", "monitoring", "resolved"]);

type BodyReadResult =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "invalid" }
  | { kind: "too_large" };

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
        title: form.get("title"),
        impact: form.get("impact"),
        serviceIds: form.get("serviceIds"),
        startedAt: form.get("startedAt"),
        summary: form.get("summary"),
        publicId: form.get("publicId"),
        lifecycleStatus: form.get("lifecycleStatus"),
        message: form.get("message"),
        idempotencyKey: form.get("idempotencyKey"),
        requestId: form.get("requestId"),
        acknowledged: form.has("acknowledged"),
      },
    };
  }

  return { kind: "invalid" };
}

function redirectResult(request: NextRequest, outcome: string, publicId?: string): NextResponse {
  const query = new URLSearchParams({ incidentMutation: outcome });
  if (publicId) query.set("incident", publicId);
  return NextResponse.redirect(new URL(`/status-center?${query.toString()}#public-incidents`, request.url), 303);
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

function parseServices(value: unknown): string[] | null {
  if (typeof value !== "string" || value.length > 2_100) return null;
  const ids = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (ids.length < 1 || ids.length > 32 || new Set(ids).size !== ids.length) return null;
  return ids.every((id) => SERVICE_ID_PATTERN.test(id)) ? ids : null;
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
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const impact = typeof body.impact === "string" ? body.impact : "";
    const serviceIds = parseServices(body.serviceIds);
    const startedAt = parseDateTime(body.startedAt);
    const summary = typeof body.summary === "string" ? body.summary.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (
      title.length < 1 || title.length > 160 || !IMPACTS.has(impact) || !serviceIds || !startedAt ||
      summary.length < 1 || summary.length > 2_000 || !UUID_PATTERN.test(idempotencyKey)
    ) {
      return wantsJson(request)
        ? jsonResponse({ error: "incident_create_input_invalid" }, 400)
        : redirectResult(request, "create_invalid");
    }
    const startedMs = Date.parse(startedAt);
    const now = Date.now();
    if (startedMs < now - 30 * 86_400_000 || startedMs > now + 5 * 60_000) {
      return wantsJson(request)
        ? jsonResponse({ error: "incident_started_at_invalid" }, 400)
        : redirectResult(request, "create_invalid");
    }
    try {
      const incident = await createStatusIncident({
        title,
        impact: impact as "none" | "minor" | "major" | "critical",
        affectedServiceIds: serviceIds,
        startedAt,
        summary,
        idempotencyKey,
        actorEmail: session.email,
        actorDiscordUserId: session.discordUserId,
        actorRole,
      });
      return wantsJson(request)
        ? jsonResponse({ incident }, 201)
        : redirectResult(request, "created", incident.publicId);
    } catch (error) {
      console.error("Status Incident作成に失敗しました", error);
      return wantsJson(request)
        ? jsonResponse({ error: "incident_create_failed" }, 503)
        : redirectResult(request, "mutation_failed");
    }
  }

  const publicId = typeof body.publicId === "string" ? body.publicId : "";
  const requestId = typeof body.requestId === "string" ? body.requestId : randomUUID();
  if (!PUBLIC_ID_PATTERN.test(publicId) || !UUID_PATTERN.test(requestId)) {
    return wantsJson(request)
      ? jsonResponse({ error: "incident_identity_invalid" }, 400)
      : redirectResult(request, "identity_invalid");
  }

  if (action === "publish") {
    if (!acknowledged(body.acknowledged)) {
      return wantsJson(request)
        ? jsonResponse({ error: "incident_publish_acknowledgement_required" }, 400)
        : redirectResult(request, "acknowledgement_required", publicId);
    }
    try {
      const incident = await publishStatusIncident({
        publicId,
        requestId,
        actorEmail: session.email,
        actorDiscordUserId: session.discordUserId,
        actorRole,
      });
      return wantsJson(request)
        ? jsonResponse({ incident })
        : redirectResult(request, "published", incident.publicId);
    } catch (error) {
      console.error("Status Incident公開に失敗しました", error);
      return wantsJson(request)
        ? jsonResponse({ error: "incident_publish_failed" }, 503)
        : redirectResult(request, "mutation_failed", publicId);
    }
  }

  if (action === "update") {
    const lifecycleStatus = typeof body.lifecycleStatus === "string" ? body.lifecycleStatus : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!LIFECYCLE.has(lifecycleStatus) || message.length < 1 || message.length > 2_000) {
      return wantsJson(request)
        ? jsonResponse({ error: "incident_update_input_invalid" }, 400)
        : redirectResult(request, "update_invalid", publicId);
    }
    if (lifecycleStatus === "resolved" && !acknowledged(body.acknowledged)) {
      return wantsJson(request)
        ? jsonResponse({ error: "incident_resolve_acknowledgement_required" }, 400)
        : redirectResult(request, "acknowledgement_required", publicId);
    }
    try {
      const incident = await updateStatusIncident({
        publicId,
        lifecycleStatus: lifecycleStatus as "investigating" | "identified" | "monitoring" | "resolved",
        message,
        requestId,
        actorEmail: session.email,
        actorDiscordUserId: session.discordUserId,
        actorRole,
      });
      return wantsJson(request)
        ? jsonResponse({ incident })
        : redirectResult(request, lifecycleStatus === "resolved" ? "resolved" : "updated", incident.publicId);
    } catch (error) {
      console.error("Status Incident更新に失敗しました", error);
      return wantsJson(request)
        ? jsonResponse({ error: "incident_update_failed" }, 503)
        : redirectResult(request, "mutation_failed", publicId);
    }
  }

  return jsonResponse({ error: "action_invalid" }, 400);
}
