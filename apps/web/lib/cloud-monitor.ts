import "server-only";
import { CLOUD_STATUSES, type CloudEnvelope, type CloudStatus } from "./cloud-monitor-core";

export type CloudTarget = {
  id: string; provider: string; display_name: string; enabled: boolean;
  status: CloudStatus; reason_code: string; received_at: string | null;
  observed_at: string | null; stale_after_seconds: number;
};

async function supabase(path: string, init?: RequestInit): Promise<unknown> {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("cloud_monitor_not_configured");
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    cache: "no-store", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("cloud_monitor_store_unavailable");
  return response.json();
}

export async function ingestCloudMonitor(payload: CloudEnvelope, nonce: string, hash: string): Promise<string> {
  const result = await supabase("rpc/ingest_cloud_monitor_v1", { method: "POST", body: JSON.stringify({
    p_server_id: payload.serverId, p_nonce: nonce, p_body_sha256: hash,
    p_observed_at: payload.observedAt, p_results: payload.results,
  }) });
  if (typeof result !== "string") throw new Error("invalid_cloud_monitor_response");
  return result;
}

export async function getCloudTargets(): Promise<CloudTarget[]> {
  const result = await supabase("cloud_monitor_targets?select=id,provider,display_name,enabled,status,reason_code,received_at,observed_at,stale_after_seconds&order=provider.asc,id.asc&limit=500");
  if (!Array.isArray(result)) throw new Error("invalid_cloud_monitor_response");
  for (const row of result) {
    if (!row || typeof row.id !== "string" || typeof row.display_name !== "string" ||
      typeof row.provider !== "string" || typeof row.enabled !== "boolean" || !CLOUD_STATUSES.includes(row.status) ||
      typeof row.reason_code !== "string" || !Number.isInteger(row.stale_after_seconds) ||
      row.stale_after_seconds < 120 || row.stale_after_seconds > 86400 ||
      (row.received_at !== null && (typeof row.received_at !== "string" || !Number.isFinite(Date.parse(row.received_at)))) ||
      (row.observed_at !== null && (typeof row.observed_at !== "string" || !Number.isFinite(Date.parse(row.observed_at))))) {
      throw new Error("invalid_cloud_monitor_response");
    }
  }
  return result as CloudTarget[];
}
