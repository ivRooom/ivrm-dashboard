import "server-only";
import { parseRuntimeInventory, type RuntimeInventory } from "./runtime-inventory-core";

export type RuntimeObservation = RuntimeInventory & { receivedAt: string };
export function runtimeInventoryEnabled(): boolean { return process.env.IVRM_RUNTIME_INVENTORY_ENABLED === "true"; }
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("runtime_not_configured");
  const response = await fetch(`${url}/rest/v1/${path}`, { ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("runtime_store_unavailable");
  return response.json();
}
export async function ingestRuntimeInventory(payload: RuntimeInventory, nonce: string): Promise<unknown> {
  return request("rpc/ingest_runtime_inventory_v1", { method: "POST", body: JSON.stringify({
    p_server_id: payload.serverId, p_observed_at: payload.observedAt, p_nonce: nonce, p_containers: payload.containers,
  }) });
}
export async function getRuntimeInventory(): Promise<RuntimeObservation[]> {
  if (!runtimeInventoryEnabled()) return [];
  const rows = await request("runtime_inventory?select=server_id,observed_at,received_at,containers&limit=3");
  if (!Array.isArray(rows)) throw new Error("invalid_runtime_response");
  return rows.map(row => {
    if (!row || typeof row.received_at !== "string" || !Number.isFinite(Date.parse(row.received_at)) || typeof row.observed_at !== "string" || !Number.isFinite(Date.parse(row.observed_at))) throw new Error("invalid_runtime_response");
    // Validate the historical payload against its observation time, then evaluate freshness at rendering.
    const payload = parseRuntimeInventory(new TextEncoder().encode(JSON.stringify({ kind: "runtime-inventory-v1", serverId: row.server_id, observedAt: row.observed_at, containers: row.containers })), Date.parse(row.observed_at));
    return { ...payload, receivedAt: row.received_at };
  });
}
