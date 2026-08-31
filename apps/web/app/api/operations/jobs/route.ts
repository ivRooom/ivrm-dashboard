import { createHash, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import {
  DISCORD_SESSION_COOKIE,
  getDiscordAuthMode,
  resolveDiscordConsoleSession,
} from "../../../../lib/discord-auth";
import {
  getOperationDefinition,
  isOperationType,
  validateIdempotencyKey,
  validateOperationConfirmation,
  validateOperationPayload,
  type OperationType,
} from "../../../../lib/operation-catalog";
import {
  enqueueDiscordOperationJob,
  listDiscordOperationJobs,
  MC_MAIN_OPERATION_ACTIONS,
  MC_MAIN_OPERATION_TARGET,
  recordOperationRequestDenied,
  type McMainOperationAction,
} from "../../../../lib/mc-main-operations";
import type { ConsoleRole } from "../../../../lib/console-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 1_024;
const ACTIONS = new Set<string>(MC_MAIN_OPERATION_ACTIONS);
const ROLE_RANK: Record<ConsoleRole, number> = {
  viewer: 0,
  operator: 1,
  administrator: 2,
  owner: 3,
};

type ResolvedSession = Awaited<ReturnType<typeof resolveDiscordConsoleSession>>;

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function trustedOrigin(): string {
  const redirectUri = process.env.DISCORD_REDIRECT_URI?.trim();
  if (!redirectUri) throw new Error("DISCORD_REDIRECT_URI is not configured");
  return new URL(redirectUri).origin;
}

function validateRequestOrigin(request: NextRequest): boolean {
  try {
    const origin = request.headers.get("origin");
    const host = request.headers.get("host")?.toLowerCase() ?? "";
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase() ?? host;
    const trusted = new URL(trustedOrigin());
    return Boolean(
      origin &&
      origin === trusted.origin &&
      request.nextUrl.origin === trusted.origin &&
      host === trusted.host &&
      forwardedHost === trusted.host
    );
  } catch {
    return false;
  }
}

async function resolveSession(): Promise<ResolvedSession> {
  if (getDiscordAuthMode() === "disabled") return null;
  const store = await cookies();
  const token = store.get(DISCORD_SESSION_COOKIE)?.value ?? null;
  if (!token) return null;
  return resolveDiscordConsoleSession(token);
}

function isAllowedAction(value: unknown): value is McMainOperationAction {
  return typeof value === "string" && ACTIONS.has(value);
}

function roleAllows(role: ConsoleRole, operationType: OperationType): boolean {
  const definition = getOperationDefinition(operationType);
  return ROLE_RANK[role] >= ROLE_RANK[definition.requiredRole];
}

async function readLimitedJson(request: NextRequest): Promise<Record<string, unknown> | null | "too_large"> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return "too_large";
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) return null;
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel("payload_too_large").catch(() => undefined);
        return "too_large";
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return null;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    const session = await resolveSession();
    if (!session) return json({ error: "discord_authentication_required" }, 401);
    const jobs = await listDiscordOperationJobs(session.discordUserId);
    return json({ jobs });
  } catch {
    console.error("Operation Job一覧の取得に失敗しました");
    return json({ error: "operation_jobs_unavailable" }, 503);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!validateRequestOrigin(request)) {
    return json({ error: "origin_or_host_mismatch" }, 403);
  }
  if (process.env.IVRM_OPERATION_REQUESTS_ENABLED?.trim().toLowerCase() !== "true") {
    return json({ error: "operation_requests_disabled" }, 503);
  }

  let session: NonNullable<ResolvedSession>;
  try {
    const resolved = await resolveSession();
    if (!resolved) return json({ error: "discord_authentication_required" }, 401);
    session = resolved;
  } catch {
    return json({ error: "session_unavailable" }, 503);
  }

  const requestId = randomUUID();
  const body = await readLimitedJson(request);
  if (body === "too_large") {
    await recordOperationRequestDenied({
      requestId,
      discordUserId: session.discordUserId,
      role: session.consoleRole,
      reason: "request_body_too_large",
    });
    return json({ error: "request_body_too_large" }, 413);
  }
  if (!body || Object.keys(body).some((key) => !["target", "action", "confirmation", "payload"].includes(key))) {
    await recordOperationRequestDenied({
      requestId,
      discordUserId: session.discordUserId,
      role: session.consoleRole,
      reason: "request_body_invalid",
    });
    return json({ error: "request_body_invalid" }, 400);
  }

  const target = body.target;
  const action = body.action;
  if (target !== MC_MAIN_OPERATION_TARGET) {
    await recordOperationRequestDenied({ requestId, discordUserId: session.discordUserId, role: session.consoleRole, reason: "target_not_allowed" });
    return json({ error: "target_not_allowed" }, 400);
  }
  if (!isAllowedAction(action) || !isOperationType(action)) {
    await recordOperationRequestDenied({ requestId, discordUserId: session.discordUserId, role: session.consoleRole, reason: "action_not_allowed" });
    return json({ error: "action_not_allowed" }, 400);
  }
  if (!roleAllows(session.consoleRole, action)) {
    await recordOperationRequestDenied({ requestId, discordUserId: session.discordUserId, role: session.consoleRole, reason: "insufficient_role", action });
    return json({ error: "insufficient_role" }, 403);
  }

  try {
    validateOperationPayload(body.payload ?? {});
  } catch {
    await recordOperationRequestDenied({ requestId, discordUserId: session.discordUserId, role: session.consoleRole, reason: "payload_not_allowed", action });
    return json({ error: "payload_not_allowed" }, 400);
  }
  if (!validateOperationConfirmation(action, body.confirmation)) {
    await recordOperationRequestDenied({ requestId, discordUserId: session.discordUserId, role: session.consoleRole, reason: "confirmation_invalid", action });
    return json({ error: "confirmation_invalid" }, 400);
  }

  let idempotencyKey: string;
  try {
    idempotencyKey = validateIdempotencyKey(request.headers.get("idempotency-key"));
  } catch {
    await recordOperationRequestDenied({ requestId, discordUserId: session.discordUserId, role: session.consoleRole, reason: "idempotency_invalid", action });
    return json({ error: "idempotency_invalid" }, 400);
  }

  try {
    const result = await enqueueDiscordOperationJob({
      discordSessionId: session.sessionId,
      action,
      idempotencyKeyHash: createHash("sha256").update(idempotencyKey, "utf8").digest("hex"),
      confirmation: typeof body.confirmation === "string" && body.confirmation ? body.confirmation : null,
      requestId,
    });
    if (result.outcome === "conflict") {
      return json({ job: result, error: result.errorCode ?? "operation_conflict" }, 409);
    }
    if (result.outcome === "denied") {
      const status = result.errorCode === "insufficient_role" ? 403 : 400;
      return json({ job: result, error: result.errorCode ?? "operation_denied" }, status);
    }
    return json({ job: result }, result.outcome === "created" ? 201 : 200);
  } catch {
    console.error("Operation Job作成に失敗しました");
    return json({ error: "operation_enqueue_failed" }, 503);
  }
}
