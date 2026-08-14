import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getConsoleSession, hasConsoleRole } from "../../../../lib/console-auth";
import { updateReliabilitySloPolicy } from "../../../../lib/reliability-slo";
import type { ReliabilitySloServiceId } from "../../../../lib/reliability";
import { parseIncidentRange } from "../../../../lib/unified-incidents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SERVICE_IDS = new Set<ReliabilitySloServiceId>([
  "overall",
  "host",
  "container",
  "backup",
]);

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
    serviceId: form.get("serviceId"),
    targetPercent: form.get("targetPercent"),
    enabled: form.has("enabled"),
    range: form.get("range"),
  };
}

function serviceId(value: unknown): ReliabilitySloServiceId | null {
  return typeof value === "string" && SERVICE_IDS.has(value as ReliabilitySloServiceId)
    ? (value as ReliabilitySloServiceId)
    : null;
}

function targetPercent(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (!/^\d{1,2}(?:\.\d{1,4})?$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 100 ? parsed : undefined;
}

function enabled(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === "on") return true;
  if (value === "false" || value === "0" || value === null || value === undefined) return false;
  return null;
}

function redirectResult(request: NextRequest, range: string, outcome: string): NextResponse {
  return NextResponse.redirect(
    new URL(`/reliability?range=${encodeURIComponent(range)}&policy=${encodeURIComponent(outcome)}#slo-budget`, request.url),
    303,
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) {
    return jsonResponse({ error: "origin_mismatch" }, 403);
  }

  const session = await getConsoleSession();
  const actorRole = session.role;
  if (
    !hasConsoleRole(session, "administrator") ||
    (actorRole !== "administrator" && actorRole !== "owner")
  ) {
    return jsonResponse({ error: "administrator_role_required" }, 403);
  }

  const body = await readBody(request);
  if (!body) return jsonResponse({ error: "request_body_invalid" }, 400);

  const parsedServiceId = serviceId(body.serviceId);
  const parsedTarget = targetPercent(body.targetPercent);
  const parsedEnabled = enabled(body.enabled);
  const range = parseIncidentRange(typeof body.range === "string" ? body.range : null);

  if (!parsedServiceId) {
    return wantsJson(request)
      ? jsonResponse({ error: "service_id_invalid" }, 400)
      : redirectResult(request, range, "service_invalid");
  }
  if (parsedTarget === undefined) {
    return wantsJson(request)
      ? jsonResponse({ error: "target_percent_invalid" }, 400)
      : redirectResult(request, range, "target_invalid");
  }
  if (parsedEnabled === null || (parsedEnabled && parsedTarget === null)) {
    return wantsJson(request)
      ? jsonResponse({ error: "enabled_target_required" }, 400)
      : redirectResult(request, range, "target_required");
  }

  try {
    const policy = await updateReliabilitySloPolicy({
      serviceId: parsedServiceId,
      targetPercent: parsedTarget,
      enabled: parsedEnabled,
      requestId: randomUUID(),
      actorEmail: session.email,
      actorRole,
    });
    return wantsJson(request)
      ? jsonResponse({ policy })
      : redirectResult(request, range, "updated");
  } catch (error) {
    console.error("Reliability SLO Policy更新に失敗しました", error);
    return wantsJson(request)
      ? jsonResponse({ error: "slo_policy_update_failed" }, 503)
      : redirectResult(request, range, "update_failed");
  }
}
