export const CLOUD_STATUSES = ["operational", "degraded", "outage", "unknown", "error"] as const;
export type CloudStatus = typeof CLOUD_STATUSES[number];
const CODES = new Set(["ok", "not_configured", "auth_error", "forbidden", "timeout", "provider_error", "not_found", "unexpected_state", "dns_mismatch"]);
export type CloudResult = { id: string; status: CloudStatus; reasonCode: string };
export type CloudEnvelope = { kind: "cloud-monitor-v1"; serverId: string; observedAt: string; results: CloudResult[] };

export function parseCloudEnvelope(raw: Uint8Array, now = Date.now()): CloudEnvelope {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_payload");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== "kind,observedAt,results,serverId" || row.kind !== "cloud-monitor-v1" ||
    typeof row.serverId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(row.serverId) ||
    typeof row.observedAt !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(row.observedAt) ||
    !Number.isFinite(Date.parse(row.observedAt)) || Math.abs(now - Date.parse(row.observedAt)) > 300_000 ||
    Date.parse(row.observedAt) > now + 30_000 ||
    !Array.isArray(row.results) || row.results.length < 1 || row.results.length > 50) throw new Error("invalid_payload");
  const seen = new Set<string>();
  for (const item of row.results) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
      Object.keys(item).sort().join() !== "id,reasonCode,status" ||
      typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(item.id) || seen.has(item.id) ||
      !CLOUD_STATUSES.includes(item.status) || !CODES.has(item.reasonCode) ||
      (item.status === "operational" && item.reasonCode !== "ok")) throw new Error("invalid_payload");
    seen.add(item.id);
  }
  return row as CloudEnvelope;
}

export function cloudHealth(status: CloudStatus, receivedAt: string | null, staleSeconds: number, now = Date.now()): CloudStatus | "stale" {
  if (!receivedAt) return "unknown";
  const time = Date.parse(receivedAt);
  if (!Number.isFinite(time) || time > now + 30_000) return "unknown";
  return now - time > staleSeconds * 1000 ? "stale" : status;
}
