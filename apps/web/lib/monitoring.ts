export type HostStatus = "online" | "offline" | "stale" | "error";

type HostRow = {
  id: string;
  server_id: string;
  display_name: string;
  provider: string;
  environment: string;
  enabled: boolean;
};

type HeartbeatRow = {
  host_id: string;
  agent_version: string;
  received_at: string;
  sent_at: string;
  cpu_count: number;
  memory_total_bytes: number;
  memory_available_bytes: number;
  disk_total_bytes: number;
  disk_available_bytes: number;
  load_average_1: number;
  load_average_5: number;
  load_average_15: number;
  uptime_seconds: number;
};

export type HostOverview = {
  id: string;
  serverId: string;
  displayName: string;
  provider: string;
  environment: string;
  status: Exclude<HostStatus, "error">;
  agentVersion: string | null;
  receivedAt: string | null;
  sentAt: string | null;
  ageSeconds: number | null;
  cpuCount: number | null;
  memoryTotalBytes: number | null;
  memoryAvailableBytes: number | null;
  diskTotalBytes: number | null;
  diskAvailableBytes: number | null;
  loadAverage1: number | null;
  loadAverage5: number | null;
  loadAverage15: number | null;
  uptimeSeconds: number | null;
};

export type MonitoringSnapshot = {
  hosts: HostOverview[];
  generatedAt: string;
};

const ONLINE_THRESHOLD_SECONDS = 45;
const STALE_THRESHOLD_SECONDS = 180;
const HEARTBEAT_FETCH_LIMIT = 500;

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

async function fetchSupabase<T>(path: string): Promise<T> {
  const { url, serviceRoleKey } = supabaseConfiguration();
  const response = await fetch(`${url}${path}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Supabase APIが${response.status}を返しました`);
  }

  return (await response.json()) as T;
}

function determineStatus(ageSeconds: number | null): Exclude<HostStatus, "error"> {
  if (ageSeconds === null || ageSeconds > STALE_THRESHOLD_SECONDS) {
    return "offline";
  }
  if (ageSeconds > ONLINE_THRESHOLD_SECONDS) {
    return "stale";
  }
  return "online";
}

export async function getMonitoringSnapshot(): Promise<MonitoringSnapshot> {
  const now = new Date();
  const [hosts, heartbeats] = await Promise.all([
    fetchSupabase<HostRow[]>(
      "/rest/v1/hosts?select=id,server_id,display_name,provider,environment,enabled&enabled=eq.true&order=display_name.asc",
    ),
    fetchSupabase<HeartbeatRow[]>(
      `/rest/v1/agent_heartbeats?select=host_id,agent_version,received_at,sent_at,cpu_count,memory_total_bytes,memory_available_bytes,disk_total_bytes,disk_available_bytes,load_average_1,load_average_5,load_average_15,uptime_seconds&order=received_at.desc&limit=${HEARTBEAT_FETCH_LIMIT}`,
    ),
  ]);

  const latestByHost = new Map<string, HeartbeatRow>();
  for (const heartbeat of heartbeats) {
    if (!latestByHost.has(heartbeat.host_id)) {
      latestByHost.set(heartbeat.host_id, heartbeat);
    }
  }

  return {
    generatedAt: now.toISOString(),
    hosts: hosts.map((host) => {
      const heartbeat = latestByHost.get(host.id) ?? null;
      const receivedAtMilliseconds = heartbeat
        ? Date.parse(heartbeat.received_at)
        : Number.NaN;
      const ageSeconds = Number.isFinite(receivedAtMilliseconds)
        ? Math.max(0, Math.floor((now.getTime() - receivedAtMilliseconds) / 1_000))
        : null;

      return {
        id: host.id,
        serverId: host.server_id,
        displayName: host.display_name,
        provider: host.provider,
        environment: host.environment,
        status: determineStatus(ageSeconds),
        agentVersion: heartbeat?.agent_version ?? null,
        receivedAt: heartbeat?.received_at ?? null,
        sentAt: heartbeat?.sent_at ?? null,
        ageSeconds,
        cpuCount: heartbeat?.cpu_count ?? null,
        memoryTotalBytes: heartbeat?.memory_total_bytes ?? null,
        memoryAvailableBytes: heartbeat?.memory_available_bytes ?? null,
        diskTotalBytes: heartbeat?.disk_total_bytes ?? null,
        diskAvailableBytes: heartbeat?.disk_available_bytes ?? null,
        loadAverage1: heartbeat?.load_average_1 ?? null,
        loadAverage5: heartbeat?.load_average_5 ?? null,
        loadAverage15: heartbeat?.load_average_15 ?? null,
        uptimeSeconds: heartbeat?.uptime_seconds ?? null,
      };
    }),
  };
}
