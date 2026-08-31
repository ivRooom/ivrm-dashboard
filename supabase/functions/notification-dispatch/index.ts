import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type NotificationSource = "host" | "container" | "backup" | "reliability";
type NotificationSeverity = "info" | "warning" | "critical" | "recovery";
type EventSeverity = Exclude<NotificationSeverity, "recovery">;

type LegacyDeliveryRow = {
  id: number;
  source_type: NotificationSource;
  server_id: string;
  entity_type: NotificationSource;
  entity_name: string;
  transition: "opened" | "escalated" | "recovered" | "event";
  severity: NotificationSeverity;
  title: string;
  message: string;
  detail_href: string;
  occurred_at: string;
  attempts: number;
};

type EventDeliveryRow = {
  id: number;
  event_id: number;
  channel_id: number;
  provider_type: "discord";
  event_type:
    | "incident_published"
    | "incident_update_published"
    | "incident_resolved"
    | "maintenance_published"
    | "maintenance_cancelled"
    | "announcement_published";
  source_type: "incident" | "maintenance" | "announcement";
  source_public_id: string;
  severity: EventSeverity;
  title: string;
  message: string;
  detail_href: string;
  occurred_at: string;
  attempts: number;
};

type DeliveryOutcome = "sent" | "failed" | "suppressed";
type SupabaseClient = ReturnType<typeof createClient>;

const encoder = new TextEncoder();
const MAX_BATCH = 10;
const CONSOLE_BASE_URL = "https://console.ivrm.jp";

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function discordWebhookUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "discord.com" && url.hostname !== "discordapp.com") return null;
    if (!/^\/api\/webhooks\/[0-9]+\/[^/]+\/?$/.test(url.pathname)) return null;
    url.searchParams.set("wait", "true");
    return url;
  } catch {
    return null;
  }
}

function colorForSeverity(severity: NotificationSeverity): number {
  switch (severity) {
    case "critical": return 0xed4245;
    case "warning": return 0xfee75c;
    case "recovery": return 0x57f287;
    default: return 0x5865f2;
  }
}

function transitionLabel(transition: LegacyDeliveryRow["transition"]): string {
  return { opened: "発生", escalated: "重大化", recovered: "復旧", event: "イベント" }[transition];
}

function sourceLabel(source: NotificationSource): string {
  return {
    host: "HOST",
    container: "CONTAINER",
    backup: "BACKUP",
    reliability: "SLO",
  }[source];
}

function eventLabel(eventType: EventDeliveryRow["event_type"]): string {
  return {
    incident_published: "障害公開",
    incident_update_published: "障害更新",
    incident_resolved: "障害復旧",
    maintenance_published: "メンテナンス予定",
    maintenance_cancelled: "メンテナンス中止",
    announcement_published: "お知らせ公開",
  }[eventType];
}

function eventSourceLabel(source: EventDeliveryRow["source_type"]): string {
  return {
    incident: "INCIDENT",
    maintenance: "MAINTENANCE",
    announcement: "ANNOUNCEMENT",
  }[source];
}

function detailUrl(href: string): string | undefined {
  if (!href.startsWith("/") || href.startsWith("//")) return undefined;
  try {
    const url = new URL(href, CONSOLE_BASE_URL);
    if (url.origin !== CONSOLE_BASE_URL) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function responseExternalId(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("id" in body)) return null;
    const id = (body as { id?: unknown }).id;
    return typeof id === "string" && id.length <= 128 ? id : null;
  } catch {
    return null;
  }
}

async function postDiscord(webhook: URL, payload: Record<string, unknown>): Promise<Response> {
  return await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
}

async function deliverLegacyRow(
  client: SupabaseClient,
  webhook: URL,
  claimToken: string,
  row: LegacyDeliveryRow,
): Promise<DeliveryOutcome> {
  try {
    const { data: blockReason, error: blockError } = await client.rpc("notification_delivery_block_reason_v1", {
      p_id: row.id,
      p_claim_token: claimToken,
    });
    if (blockError || (typeof blockReason === "string" && blockReason.length > 0)) {
      const reason = blockError ? "delivery_gate_failed" : String(blockReason).slice(0, 256);
      const { error: suppressError } = await client.rpc("suppress_notification_delivery_v1", {
        p_id: row.id,
        p_claim_token: claimToken,
        p_reason: reason,
      });
      return suppressError ? "failed" : "suppressed";
    }

    const payload = {
      username: "IVRM Monitor",
      allowed_mentions: { parse: [] as string[] },
      embeds: [{
        title: row.title.slice(0, 256),
        description: row.message.slice(0, 4096),
        color: colorForSeverity(row.severity),
        url: detailUrl(row.detail_href),
        fields: [
          { name: "状態", value: transitionLabel(row.transition), inline: true },
          { name: "対象", value: `${sourceLabel(row.source_type)} / ${row.entity_name}`.slice(0, 1024), inline: true },
          { name: "Server", value: row.server_id.slice(0, 1024), inline: true },
        ],
        footer: { text: `IVRM Notification Center / Attempt ${row.attempts}` },
        timestamp: row.occurred_at,
      }],
    };

    const response = await postDiscord(webhook, payload);
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      await client.rpc("complete_notification_delivery_v1", {
        p_id: row.id,
        p_claim_token: claimToken,
        p_success: false,
        p_http_status: response.status,
        p_external_delivery_id: null,
        p_error_code: `discord_http_${response.status}`,
      });
      return "failed";
    }

    const externalId = await responseExternalId(response);
    const { error: completeError } = await client.rpc("complete_notification_delivery_v1", {
      p_id: row.id,
      p_claim_token: claimToken,
      p_success: true,
      p_http_status: response.status,
      p_external_delivery_id: externalId,
      p_error_code: null,
    });
    return completeError ? "failed" : "sent";
  } catch {
    await client.rpc("complete_notification_delivery_v1", {
      p_id: row.id,
      p_claim_token: claimToken,
      p_success: false,
      p_http_status: null,
      p_external_delivery_id: null,
      p_error_code: "dispatcher_row_error",
    });
    return "failed";
  }
}

async function deliverEventRow(
  client: SupabaseClient,
  webhook: URL,
  claimToken: string,
  row: EventDeliveryRow,
): Promise<DeliveryOutcome> {
  try {
    const { data: blockReason, error: blockError } = await client.rpc("notification_event_delivery_block_reason_v1", {
      p_id: row.id,
      p_claim_token: claimToken,
    });
    if (blockError || (typeof blockReason === "string" && blockReason.length > 0)) {
      const reason = blockError ? "delivery_gate_failed" : String(blockReason).slice(0, 256);
      const { error: suppressError } = await client.rpc("suppress_notification_event_delivery_v1", {
        p_id: row.id,
        p_claim_token: claimToken,
        p_reason: reason,
      });
      return suppressError ? "failed" : "suppressed";
    }

    const payload = {
      username: "IVRM Status",
      allowed_mentions: { parse: [] as string[] },
      embeds: [{
        title: row.title.slice(0, 256),
        description: row.message.slice(0, 4096),
        color: colorForSeverity(row.severity),
        url: detailUrl(row.detail_href),
        fields: [
          { name: "状態", value: eventLabel(row.event_type), inline: true },
          {
            name: "対象",
            value: `${eventSourceLabel(row.source_type)} / ${row.source_public_id}`.slice(0, 1024),
            inline: true,
          },
        ],
        footer: { text: `IVRM Status Delivery / Attempt ${row.attempts}` },
        timestamp: row.occurred_at,
      }],
    };

    const response = await postDiscord(webhook, payload);
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      await client.rpc("complete_notification_event_delivery_v1", {
        p_id: row.id,
        p_claim_token: claimToken,
        p_success: false,
        p_http_status: response.status,
        p_external_delivery_id: null,
        p_error_code: `discord_http_${response.status}`,
      });
      return "failed";
    }

    const externalId = await responseExternalId(response);
    const { error: completeError } = await client.rpc("complete_notification_event_delivery_v1", {
      p_id: row.id,
      p_claim_token: claimToken,
      p_success: true,
      p_http_status: response.status,
      p_external_delivery_id: externalId,
      p_error_code: null,
    });
    return completeError ? "failed" : "sent";
  } catch {
    await client.rpc("complete_notification_event_delivery_v1", {
      p_id: row.id,
      p_claim_token: claimToken,
      p_success: false,
      p_http_status: null,
      p_external_delivery_id: null,
      p_error_code: "dispatcher_row_error",
    });
    return "failed";
  }
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return jsonResponse(405, { ok: false, error: "method_not_allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { ok: false, error: "runtime_configuration_missing" });
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const schedulerToken = request.headers.get("x-ivrm-dispatch-token")?.trim();
  if (!schedulerToken || schedulerToken.length < 32 || schedulerToken.length > 256) {
    return jsonResponse(401, { ok: false, error: "unauthorized" });
  }

  const tokenHash = await sha256Hex(schedulerToken);
  const { data: verified, error: verifyError } = await client.rpc("verify_notification_dispatch_token_v1", {
    p_token_sha256: tokenHash,
  });
  if (verifyError || verified !== true) {
    return jsonResponse(401, { ok: false, error: "unauthorized" });
  }

  const webhook = discordWebhookUrl(Deno.env.get("DISCORD_WEBHOOK_URL")?.trim() ?? "");
  if (!webhook) {
    await client.rpc("mark_notification_dispatch_v1", {
      p_success: false,
      p_batch_count: 0,
      p_error_code: "channel_unconfigured",
    });
    return jsonResponse(503, { ok: false, error: "channel_unconfigured" });
  }

  let sent = 0;
  let failed = 0;
  let suppressed = 0;
  let claimFailures = 0;
  let claimed = 0;

  // Legacy monitoring outbox and Status lifecycle deliveries are intentionally
  // claimed and processed independently. A failure in one path does not prevent
  // the other path from making progress.
  const legacyClaimToken = crypto.randomUUID();
  const { data: legacyData, error: legacyClaimError } = await client.rpc("claim_notification_outbox_v1", {
    p_claim_token: legacyClaimToken,
    p_limit: MAX_BATCH,
  });
  if (legacyClaimError) {
    claimFailures += 1;
  } else {
    const rows = (Array.isArray(legacyData) ? legacyData : []) as LegacyDeliveryRow[];
    claimed += rows.length;
    for (const row of rows) {
      const outcome = await deliverLegacyRow(client, webhook, legacyClaimToken, row);
      if (outcome === "sent") sent += 1;
      else if (outcome === "suppressed") suppressed += 1;
      else failed += 1;
    }
  }

  const eventClaimToken = crypto.randomUUID();
  const { data: eventData, error: eventClaimError } = await client.rpc("claim_notification_deliveries_v1", {
    p_provider_type: "discord",
    p_claim_token: eventClaimToken,
    p_limit: MAX_BATCH,
  });
  if (eventClaimError) {
    claimFailures += 1;
  } else {
    const rows = (Array.isArray(eventData) ? eventData : []) as EventDeliveryRow[];
    claimed += rows.length;
    for (const row of rows) {
      const outcome = await deliverEventRow(client, webhook, eventClaimToken, row);
      if (outcome === "sent") sent += 1;
      else if (outcome === "suppressed") suppressed += 1;
      else failed += 1;
    }
  }

  const dispatchSucceeded = failed === 0 && claimFailures === 0;
  await client.rpc("mark_notification_dispatch_v1", {
    p_success: dispatchSucceeded,
    p_batch_count: claimed,
    p_error_code: dispatchSucceeded
      ? null
      : claimFailures > 0
      ? "partial_claim_failure"
      : "partial_delivery_failure",
  });

  return jsonResponse(200, {
    ok: dispatchSucceeded,
    claimed,
    sent,
    failed,
    suppressed,
    claimFailures,
  });
});
