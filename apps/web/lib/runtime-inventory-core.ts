export const RUNTIME_CONTAINERS: Readonly<Record<string, readonly string[]>> = {
  "aws-app-01": ["ivrm-admin", "ivrm-api", "ivrm-home", "ivrm-member", "ivrm-contact", "ivrm-cloudflared", "ivrm-runtime-caddy", "ivrm-runtime-health"],
  "lightsail-herta": ["herta-api-1", "herta-studio-1", "herta-worker-1", "herta-bot-1", "herta-postgres-1", "herta-redis-1", "herta-caddy-1", "herta-nginx-1"],
  "oci-minecraft-01": ["mc-main", "ivrm-velocity", "mc-resource-router", "ivrm-status-api", "caddy"],
};
export type RuntimeContainer = { name: string; collection: "unavailable" } | {
  name: string; collection: "ok"; state: string; health: string; restartCount: number;
  oomKilled: boolean; exitCode: number; image: string; imageId: string;
};
export type RuntimeInventory = { kind: "runtime-inventory-v1"; serverId: string; observedAt: string; containers: RuntimeContainer[] };
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export function parseRuntimeInventory(raw: Uint8Array, now = Date.now()): RuntimeInventory {
  if (raw.length > 32768) throw new Error("invalid_payload");
  const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (!object(payload) || Object.keys(payload).sort().join() !== "containers,kind,observedAt,serverId" || payload.kind !== "runtime-inventory-v1" ||
    typeof payload.serverId !== "string" || !Object.hasOwn(RUNTIME_CONTAINERS, payload.serverId) ||
    typeof payload.observedAt !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(payload.observedAt) || !Number.isFinite(Date.parse(payload.observedAt)) ||
    Date.parse(payload.observedAt) < now-300000 || Date.parse(payload.observedAt) > now+30000 || !Array.isArray(payload.containers)) throw new Error("invalid_payload");
  const expected = RUNTIME_CONTAINERS[payload.serverId];
  if (payload.containers.length !== expected.length) throw new Error("invalid_payload");
  const seen = new Set<string>();
  for (const row of payload.containers) {
    if (!object(row) || typeof row.name !== "string" || !expected.includes(row.name) || seen.has(row.name)) throw new Error("invalid_payload");
    seen.add(row.name);
    if (row.collection === "unavailable") {
      if (Object.keys(row).sort().join() !== "collection,name") throw new Error("invalid_payload");
    } else if (row.collection === "ok") {
      if (Object.keys(row).sort().join() !== "collection,exitCode,health,image,imageId,name,oomKilled,restartCount,state" ||
        typeof row.state !== "string" || !["created","running","paused","restarting","removing","exited","dead"].includes(row.state) ||
        typeof row.health !== "string" || !["starting","healthy","unhealthy","none"].includes(row.health) || typeof row.oomKilled !== "boolean" ||
        !Number.isInteger(row.restartCount) || (row.restartCount as number)<0 || (row.restartCount as number)>2147483647 ||
        !Number.isInteger(row.exitCode) || (row.exitCode as number)<0 || (row.exitCode as number)>255 ||
        typeof row.image !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,254}$/.test(row.image) ||
        typeof row.imageId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(row.imageId)) throw new Error("invalid_payload");
    } else throw new Error("invalid_payload");
  }
  return payload as RuntimeInventory;
}
