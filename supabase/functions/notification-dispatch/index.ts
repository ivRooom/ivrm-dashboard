import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type DeliveryRow = {
  id: number;
  source_type: "host" | "container" | "backup";
  server_id: string;
  entity_type: "host" | "container" | "backup";
  entity_name: string;
  transition: "opened" | "escalated" | "recovered" | "event";
  severity: "info" | "warning" | "critical" | "recovery";
  title: string;
  message: string;
  detail_href: string;
  occurred_at: string;
  attempts: number;
};

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
    if (!url.pathname.startsWith("/api/webhooks/")) return null;
    url.searchParams.set("wait", "true");
    return url;
  } catch {
    return null;
  }
}

function colorForSeverity(severity: DeliveryRow["severity"]): number {
  switch (severity) {
    case "critical": return 0xed4245;
    case "warning": return 0xfee75c;
    case "recovery": return 0x57f287;
    default: return 0x5865f2;
  }
}

function transitionLabel(transition: DeliveryRow["transition"]): string {
  return { opened: "発生", escalated: "重大化", recovered: "復旧", event: "イベント" }[transition];
}

function sourceLabel(source: DeliveryRow["source_type"]): string {
  return { host: "HOST", container: "CONTAINER", backup: "BACKUP" }[source];
}

function detailUrl(href: string): string | undefined {
  if (!href.startsWith("/") || href.startsWith("//")) return undefined;
  try { return new URL(href, CONSOLE_BASE_URL).toString(); } catch { return undefined; }
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return jsonResponse(405, { ok: false, error: "method_not_allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse(500, { ok: false, error: "runtime_configuration_missing" });

  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const schedulerToken = request.headers.get("x-ivrm-dispatch-token")?.trim();
  if (!schedulerToken || schedulerToken.length < 32 || schedulerToken.length > 256) return jsonResponse(401, { ok: false, error: "unauthorized" });

  const tokenHash = await sha256Hex(schedulerToken);
  const { data: verified, error: verifyError } = await client.rpc("verify_notification_dispatch_token_v1", { p_token_sha256: tokenHash });
  if (verifyError || verified !== true) return jsonResponse(401, { ok: false, error: "unauthorized" });

  const webhook = discordWebhookUrl(Deno.env.get("DISCORD_WEBHOOK_URL")?.trim() ?? "");
  if (!webhook) {
    await client.rpc("mark_notification_dispatch_v1", { p_success: false, p_batch_count: 0, p_error_code: "channel_unconfigured" });
    return jsonResponse(503, { ok: false, error: "channel_unconfigured" });
  }

  const claimToken = crypto.randomUUID();
  const { data, error: claimError } = await client.rpc("claim_notification_outbox_v1", { p_claim_token: claimToken, p_limit: MAX_BATCH });
  if (claimError) {
    await client.rpc("mark_notification_dispatch_v1", { p_success: false, p_batch_count: 0, p_error_code: "claim_failed" });
    return jsonResponse(500, { ok: false, error: "claim_failed" });
  }

  const rows = (Array.isArray(data) ? data : []) as DeliveryRow[];
  let sent = 0;
  let failed = 0;
  let suppressed = 0;

  for (const row of rows) {
    try {
      // Claim後にChannelがOFFへ切り替わる競合も安全側へ倒す。
      const { data: channelReady, error: channelError } = await client.rpc("notification_channel_ready_v1");
      if (channelError || channelReady !== true) {
        const reason = channelError ? "channel_check_failed" : "channel_disabled_during_dispatch";
        const { error: suppressError } = await client.rpc("suppress_notification_delivery_v1", {
          p_id: row.id,
          p_claim_token: claimToken,
          p_reason: reason,
        });
        if (suppressError) failed += 1;
        else suppressed += 1;
        continue;
      }

      // Payload組み立てもRow単位try内で行い、不正RowがBatch全体を止めないようにする。
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

      const response = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        failed += 1;
        await response.arrayBuffer().catch(() => undefined);
        await client.rpc("complete_notification_delivery_v1", {
          p_id: row.id, p_claim_token: claimToken, p_success: false, p_http_status: response.status,
          p_external_delivery_id: null, p_error_code: `discord_http_${response.status}`,
        });
        continue;
      }

      let externalId: string | null = null;
      try {
        const responseBody = await response.json();
        if (responseBody && typeof responseBody.id === "string" && responseBody.id.length <= 128) externalId = responseBody.id;
      } catch { externalId = null; }

      const { error: completeError } = await client.rpc("complete_notification_delivery_v1", {
        p_id: row.id, p_claim_token: claimToken, p_success: true, p_http_status: response.status,
        p_external_delivery_id: externalId, p_error_code: null,
      });
      if (completeError) failed += 1; else sent += 1;
    } catch {
      failed += 1;
      await client.rpc("complete_notification_delivery_v1", {
        p_id: row.id, p_claim_token: claimToken, p_success: false, p_http_status: null,
        p_external_delivery_id: null, p_error_code: "dispatcher_row_error",
      });
    }
  }

  const dispatchSucceeded = failed === 0;
  await client.rpc("mark_notification_dispatch_v1", {
    p_success: dispatchSucceeded,
    p_batch_count: rows.length,
    p_error_code: dispatchSucceeded ? null : "partial_delivery_failure",
  });
  return jsonResponse(200, { ok: dispatchSucceeded, claimed: rows.length, sent, failed, suppressed });
});
