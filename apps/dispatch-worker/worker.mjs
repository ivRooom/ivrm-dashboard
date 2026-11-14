// IVRM notification dispatch worker.
//
// Polling replacement for the Supabase Edge Function `notification-dispatch`
// (which was invoked every minute by pg_cron -> pg_net). This worker runs the
// exact same claim/deliver/complete cycle directly against PostgreSQL:
//
//   claim_notification_outbox_v1 / claim_notification_deliveries_v1
//   notification_delivery_block_reason_v1 / suppress_notification_delivery_v1
//   complete_notification_delivery_v1 (+ event-delivery variants)
//   mark_notification_dispatch_v1
//
// Embed payloads, error codes and batch sizes mirror the Edge Function.

import { readFileSync } from "node:fs";
import { checkServerIdentity } from "node:tls";
import pg from "pg";

const MAX_BATCH = 10;
const CONSOLE_BASE_URL = "https://console.ivrm.jp";
const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 60_000);
const RUN_ONCE = process.env.WORKER_RUN_ONCE === "1";
const ALLOW_CUSTOM_WEBHOOK = process.env.WORKER_ALLOW_CUSTOM_WEBHOOK === "1";
const MENTION_ROLE_ID = (process.env.DISCORD_MENTION_ROLE_ID ?? "").trim();

function log(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

function readEnvFileValue(name) {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  return (process.env[name] ?? "").trim();
}

function discordWebhookUrl(raw) {
  try {
    const url = new URL(raw);
    if (!ALLOW_CUSTOM_WEBHOOK) {
      if (url.protocol !== "https:") return null;
      if (url.hostname !== "discord.com" && url.hostname !== "discordapp.com") return null;
      if (!/^\/api\/webhooks\/[0-9]+\/[^/]+\/?$/.test(url.pathname)) return null;
    }
    url.searchParams.set("wait", "true");
    return url;
  } catch {
    return null;
  }
}

function colorForSeverity(severity) {
  switch (severity) {
    case "critical": return 0xed4245;
    case "warning": return 0xfee75c;
    case "recovery": return 0x57f287;
    default: return 0x5865f2;
  }
}

// Issue #184: mention the response role only for notifications that need a
// human now — newly opened criticals, escalations, and OOM kills. Warnings,
// recoveries and re-delivery attempts never mention. Disabled unless
// DISCORD_MENTION_ROLE_ID holds a plausible Discord role id.
function shouldMentionRow(row) {
  if (!/^[0-9]{17,20}$/.test(MENTION_ROLE_ID)) return false;
  if (typeof row.signal_key === "string" && row.signal_key.endsWith(":oom_killed")) return true;
  if (row.transition === "escalated") return true;
  return row.transition === "opened" && row.severity === "critical";
}

function transitionLabel(transition) {
  return { opened: "発生", escalated: "重大化", recovered: "復旧", event: "イベント" }[transition];
}

function sourceLabel(source) {
  return { host: "HOST", container: "CONTAINER", backup: "BACKUP", reliability: "SLO", cloud: "CLOUD", points: "POINTS" }[source];
}

function eventLabel(eventType) {
  return {
    incident_published: "障害公開",
    incident_update_published: "障害更新",
    incident_resolved: "障害復旧",
    maintenance_published: "メンテナンス予定",
    maintenance_cancelled: "メンテナンス中止",
    announcement_published: "お知らせ公開",
  }[eventType];
}

function eventSourceLabel(source) {
  return { incident: "INCIDENT", maintenance: "MAINTENANCE", announcement: "ANNOUNCEMENT" }[source];
}

function detailUrl(href) {
  if (typeof href !== "string" || !href.startsWith("/") || href.startsWith("//")) return undefined;
  try {
    const url = new URL(href, CONSOLE_BASE_URL);
    if (url.origin !== CONSOLE_BASE_URL) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function rpc(pool, name, args) {
  const keys = Object.keys(args);
  const params = keys.map((k) => args[k]);
  const call = keys.map((k, i) => `"${k}" => $${i + 1}`).join(", ");
  const { rows } = await pool.query(`select public."${name}"(${call}) as value`, params);
  return rows[0]?.value;
}

async function rpcRows(pool, name, args) {
  const keys = Object.keys(args);
  const params = keys.map((k) => args[k]);
  const call = keys.map((k, i) => `"${k}" => $${i + 1}`).join(", ");
  const { rows } = await pool.query(`select * from public."${name}"(${call})`, params);
  return rows;
}

async function postDiscord(webhook, payload) {
  return await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
}

async function responseExternalId(response) {
  try {
    const body = await response.json();
    if (typeof body !== "object" || body === null || !("id" in body)) return null;
    const id = body.id;
    return typeof id === "string" && id.length <= 128 ? id : null;
  } catch {
    return null;
  }
}

async function deliverLegacyRow(pool, webhook, claimToken, row) {
  try {
    const blockReason = await rpc(pool, "notification_delivery_block_reason_v1", {
      p_id: row.id, p_claim_token: claimToken,
    }).catch(() => "__error__");
    if (blockReason === "__error__" || (typeof blockReason === "string" && blockReason.length > 0)) {
      const reason = blockReason === "__error__" ? "delivery_gate_failed" : String(blockReason).slice(0, 256);
      await rpc(pool, "suppress_notification_delivery_v1", {
        p_id: row.id, p_claim_token: claimToken, p_reason: reason,
      });
      return "suppressed";
    }

    const payload = {
      username: "IVRM Monitor",
      allowed_mentions: { parse: [] },
      embeds: [{
        title: String(row.title).slice(0, 256),
        description: String(row.message).slice(0, 4096),
        color: colorForSeverity(row.severity),
        url: detailUrl(row.detail_href),
        fields: [
          { name: "状態", value: transitionLabel(row.transition), inline: true },
          { name: "対象", value: `${sourceLabel(row.source_type)} / ${row.entity_name}`.slice(0, 1024), inline: true },
          { name: "Server", value: String(row.server_id).slice(0, 1024), inline: true },
        ],
        footer: { text: `IVRM Notification Center / Attempt ${row.attempts}` },
        timestamp: row.occurred_at,
      }],
    };
    if (shouldMentionRow(row)) {
      payload.content = `<@&${MENTION_ROLE_ID}>`;
      payload.allowed_mentions = { parse: [], roles: [MENTION_ROLE_ID] };
    }

    const response = await postDiscord(webhook, payload);
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      await rpc(pool, "complete_notification_delivery_v1", {
        p_id: row.id, p_claim_token: claimToken, p_success: false,
        p_http_status: response.status, p_external_delivery_id: null,
        p_error_code: `discord_http_${response.status}`,
      });
      return "failed";
    }
    const externalId = await responseExternalId(response);
    await rpc(pool, "complete_notification_delivery_v1", {
      p_id: row.id, p_claim_token: claimToken, p_success: true,
      p_http_status: response.status, p_external_delivery_id: externalId,
      p_error_code: null,
    });
    return "sent";
  } catch {
    await rpc(pool, "complete_notification_delivery_v1", {
      p_id: row.id, p_claim_token: claimToken, p_success: false,
      p_http_status: null, p_external_delivery_id: null,
      p_error_code: "dispatcher_row_error",
    }).catch(() => undefined);
    return "failed";
  }
}

async function deliverEventRow(pool, webhook, claimToken, row) {
  try {
    const blockReason = await rpc(pool, "notification_event_delivery_block_reason_v1", {
      p_id: row.id, p_claim_token: claimToken,
    }).catch(() => "__error__");
    if (blockReason === "__error__" || (typeof blockReason === "string" && blockReason.length > 0)) {
      const reason = blockReason === "__error__" ? "delivery_gate_failed" : String(blockReason).slice(0, 256);
      await rpc(pool, "suppress_notification_event_delivery_v1", {
        p_id: row.id, p_claim_token: claimToken, p_reason: reason,
      });
      return "suppressed";
    }

    const payload = {
      username: "IVRM Status",
      allowed_mentions: { parse: [] },
      embeds: [{
        title: String(row.title).slice(0, 256),
        description: String(row.message).slice(0, 4096),
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
      await rpc(pool, "complete_notification_event_delivery_v1", {
        p_id: row.id, p_claim_token: claimToken, p_success: false,
        p_http_status: response.status, p_external_delivery_id: null,
        p_error_code: `discord_http_${response.status}`,
      });
      return "failed";
    }
    const externalId = await responseExternalId(response);
    await rpc(pool, "complete_notification_event_delivery_v1", {
      p_id: row.id, p_claim_token: claimToken, p_success: true,
      p_http_status: response.status, p_external_delivery_id: externalId,
      p_error_code: null,
    });
    return "sent";
  } catch {
    await rpc(pool, "complete_notification_event_delivery_v1", {
      p_id: row.id, p_claim_token: claimToken, p_success: false,
      p_http_status: null, p_external_delivery_id: null,
      p_error_code: "dispatcher_row_error",
    }).catch(() => undefined);
    return "failed";
  }
}

function createPool() {
  const connectionString = readEnvFileValue("DASHBOARD_DATABASE_URL");
  const caFile = process.env.DASHBOARD_PG_CA_FILE;
  if (!connectionString) throw new Error("DASHBOARD_DATABASE_URL is not configured");
  // The connection authenticates as the PostgREST authenticator role and then
  // assumes the service role (BYPASSRLS), mirroring the Edge Function
  // service_role identity. Direct table reads (the channel gate) require it;
  // the claim/complete RPCs are SECURITY DEFINER and work either way.
  const assumeRole = (process.env.DASHBOARD_PG_ROLE ?? "ivrm_dashboard_service").trim();
  if (!/^[a-z0-9_]+$/.test(assumeRole)) throw new Error("DASHBOARD_PG_ROLE is invalid");
  const pool = new pg.Pool({
    connectionString,
    max: 2,
    application_name: "ivrm-dispatch-worker",
    ssl: caFile
      ? {
          ca: readFileSync(caFile, "utf8"),
          servername: "ivrm-db-postgres.internal",
          checkServerIdentity: (host, cert) => checkServerIdentity("ivrm-db-postgres.internal", cert),
        }
      : undefined,
  });
  pool.on("connect", async (client) => {
    await client.query(`SET ROLE ${assumeRole}`);
  });
  return pool;
}

async function runCycle(pool) {
  const { rows: channels } = await pool.query(
    "select enabled, configured from public.notification_channels where id = 1",
  );
  const channel = channels[0];
  if (!channel?.enabled || !channel?.configured) {
    log("cycle_skipped_channel_gate");
    return;
  }

  const webhook = discordWebhookUrl(readEnvFileValue("DISCORD_WEBHOOK_URL"));
  if (!webhook) {
    await rpc(pool, "mark_notification_dispatch_v1", {
      p_success: false, p_batch_count: 0, p_error_code: "channel_unconfigured",
    }).catch(() => undefined);
    log("cycle_channel_unconfigured");
    return;
  }

  let sent = 0, failed = 0, suppressed = 0, claimFailures = 0, claimed = 0;

  const legacyClaimToken = crypto.randomUUID();
  try {
    const rows = await rpcRows(pool, "claim_notification_outbox_v1", {
      p_claim_token: legacyClaimToken, p_limit: MAX_BATCH,
    });
    claimed += rows.length;
    for (const row of rows) {
      const outcome = await deliverLegacyRow(pool, webhook, legacyClaimToken, row);
      if (outcome === "sent") sent += 1;
      else if (outcome === "suppressed") suppressed += 1;
      else failed += 1;
    }
  } catch {
    claimFailures += 1;
  }

  const eventClaimToken = crypto.randomUUID();
  try {
    const rows = await rpcRows(pool, "claim_notification_deliveries_v1", {
      p_provider_type: "discord", p_claim_token: eventClaimToken, p_limit: MAX_BATCH,
    });
    claimed += rows.length;
    for (const row of rows) {
      const outcome = await deliverEventRow(pool, webhook, eventClaimToken, row);
      if (outcome === "sent") sent += 1;
      else if (outcome === "suppressed") suppressed += 1;
      else failed += 1;
    }
  } catch {
    claimFailures += 1;
  }

  const succeeded = failed === 0 && claimFailures === 0;
  await rpc(pool, "mark_notification_dispatch_v1", {
    p_success: succeeded,
    p_batch_count: claimed,
    p_error_code: succeeded ? null : claimFailures > 0 ? "partial_claim_failure" : "partial_delivery_failure",
  }).catch(() => undefined);
  log("cycle_done", { claimed, sent, failed, suppressed, claimFailures });
}

const pool = createPool();
log("worker_started", { intervalMs: INTERVAL_MS, runOnce: RUN_ONCE });

if (RUN_ONCE) {
  await runCycle(pool);
  await pool.end();
} else {
  const tick = async () => {
    try {
      await runCycle(pool);
    } catch (error) {
      log("cycle_error", { message: String(error?.message ?? error).slice(0, 256) });
    }
  };
  await tick();
  setInterval(tick, INTERVAL_MS);
}
