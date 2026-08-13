import {
  getMonitoringSnapshot,
  type ContainerOverview,
  type MonitoringSnapshot,
} from "./monitoring";

export type MinecraftOverallStatus =
  | "operational"
  | "degraded"
  | "partial_outage"
  | "major_outage"
  | "maintenance"
  | "unknown";

export type MinecraftEndpointOverview = {
  reachable: boolean;
  latencyMs: number | null;
  version: string | null;
  online: number | null;
  max: number | null;
};

export type MinecraftOverview = {
  status: MinecraftOverallStatus;
  checkedAt: string | null;
  ageSeconds: number | null;
  publicEndpoint: MinecraftEndpointOverview & {
    host: "mc.ivrm.jp";
    port: 25565;
    published: boolean;
  };
  velocity: ContainerOverview | null;
  backend: ContainerOverview | null;
  backendProbe: MinecraftEndpointOverview;
  players: {
    online: number | null;
    max: number | null;
  };
  voiceChat: {
    port: 24454;
    published: boolean;
  };
  networkPolicy: {
    proxyPortPublished: boolean;
    backendPortPublished: boolean;
    backendDirectAccessBlocked: boolean;
  };
};

type MinecraftSampleRow = {
  received_at: string;
  public_reachable: boolean;
  public_latency_ms: number | null;
  public_version: string | null;
  public_online: number | null;
  public_max: number | null;
  backend_reachable: boolean;
  backend_latency_ms: number | null;
  backend_version: string | null;
  backend_online: number | null;
  backend_max: number | null;
  proxy_port_published: boolean;
  backend_port_published: boolean;
  voice_chat_port_published: boolean;
  hosts: { server_id: string };
};

const TARGET_SERVER_ID = "oci-minecraft-01";
const STALE_SECONDS = 180;

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name}が設定されていません`);
  }
  return value;
}

function supabaseConfiguration(): { url: string; serviceRoleKey: string } {
  return {
    url: requireEnvironment("SUPABASE_URL").replace(/\/$/, ""),
    serviceRoleKey: requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

async function getLatestMinecraftSample(): Promise<MinecraftSampleRow | null> {
  const { url, serviceRoleKey } = supabaseConfiguration();
  const path =
    "/rest/v1/minecraft_samples" +
    "?select=received_at,public_reachable,public_latency_ms,public_version,public_online,public_max,backend_reachable,backend_latency_ms,backend_version,backend_online,backend_max,proxy_port_published,backend_port_published,voice_chat_port_published,hosts!inner(server_id)" +
    `&hosts.server_id=eq.${encodeURIComponent(TARGET_SERVER_ID)}` +
    "&order=received_at.desc&limit=1";
  const response = await fetch(`${url}${path}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Supabase Minecraft APIが${response.status}を返しました`);
  }

  const rows = (await response.json()) as MinecraftSampleRow[];
  return rows[0] ?? null;
}

function endpoint(
  reachable: boolean,
  latencyMs: number | null,
  version: string | null,
  online: number | null,
  maximum: number | null,
): MinecraftEndpointOverview {
  return { reachable, latencyMs, version, online, max: maximum };
}

function containerIsUnavailable(container: ContainerOverview | null): boolean {
  return (
    container === null ||
    container.status === "offline" ||
    container.status === "error" ||
    container.state !== "running" ||
    container.oomKilled
  );
}

export function determineMinecraftStatus(
  sample: MinecraftSampleRow | null,
  ageSeconds: number | null,
  velocity: ContainerOverview | null,
  backend: ContainerOverview | null,
): MinecraftOverallStatus {
  if (velocity?.maintenanceActive || backend?.maintenanceActive) return "maintenance";
  if (!sample || ageSeconds === null || ageSeconds > STALE_SECONDS) return "unknown";
  if (
    containerIsUnavailable(velocity) ||
    containerIsUnavailable(backend) ||
    !sample.proxy_port_published ||
    !sample.public_reachable
  ) return "major_outage";
  if (!sample.backend_reachable) return "partial_outage";
  if (
    velocity?.status === "stale" ||
    backend?.status === "stale" ||
    !sample.voice_chat_port_published ||
    sample.backend_port_published
  ) return "degraded";
  return "operational";
}

export async function getMinecraftOverview(
  monitoringPromise: Promise<MonitoringSnapshot> = getMonitoringSnapshot(),
): Promise<MinecraftOverview> {
  const [monitoring, sample] = await Promise.all([
    monitoringPromise,
    getLatestMinecraftSample(),
  ]);
  const targetHost = monitoring.hosts.find((host) => host.serverId === TARGET_SERVER_ID);
  const targetContainers = monitoring.containers.filter((container) => container.hostId === targetHost?.id);
  const velocity = targetContainers.find((container) => container.name === "ivrm-velocity") ?? null;
  const backend = targetContainers.find((container) => container.name === "mc-main") ?? null;

  const receivedAtMilliseconds = sample ? Date.parse(sample.received_at) : Number.NaN;
  const ageSeconds = Number.isFinite(receivedAtMilliseconds)
    ? Math.max(0, Math.floor((Date.parse(monitoring.generatedAt) - receivedAtMilliseconds) / 1_000))
    : null;
  const publicEndpoint = sample
    ? endpoint(sample.public_reachable, sample.public_latency_ms, sample.public_version, sample.public_online, sample.public_max)
    : endpoint(false, null, null, null, null);
  const backendProbe = sample
    ? endpoint(sample.backend_reachable, sample.backend_latency_ms, sample.backend_version, sample.backend_online, sample.backend_max)
    : endpoint(false, null, null, null, null);

  return {
    status: determineMinecraftStatus(sample, ageSeconds, velocity, backend),
    checkedAt: sample?.received_at ?? null,
    ageSeconds,
    publicEndpoint: {
      host: "mc.ivrm.jp",
      port: 25565,
      published: sample?.proxy_port_published ?? false,
      ...publicEndpoint,
    },
    velocity,
    backend,
    backendProbe,
    players: { online: publicEndpoint.online, max: publicEndpoint.max },
    voiceChat: { port: 24454, published: sample?.voice_chat_port_published ?? false },
    networkPolicy: {
      proxyPortPublished: sample?.proxy_port_published ?? false,
      backendPortPublished: sample?.backend_port_published ?? false,
      backendDirectAccessBlocked: sample ? !sample.backend_port_published : false,
    },
  };
}
