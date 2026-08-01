export type HostStatus = "online" | "offline" | "stale" | "error";

export type ContainerStatus =
  | HostStatus
  | "standby"
  | "maintenance";

export type ContainerState =
  | "created"
  | "running"
  | "paused"
  | "restarting"
  | "removing"
  | "exited"
  | "dead"
  | "unknown"
  | "not_found";

export type ContainerHealth =
  | "starting"
  | "healthy"
  | "unhealthy"
  | "none"
  | "unknown";

export type ContainerExpectedState = "running" | "stopped" | "absent";

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

type ContainerSampleRow = {
  host_id: string;
  container_name: string;
  state: ContainerState;
  health: ContainerHealth;
  restart_count: number;
  oom_killed: boolean;
  exit_code: number | null;
  received_at: string;
};

type ContainerExpectationRow = {
  host_id: string;
  container_name: string;
  expected_state: ContainerExpectedState;
  maintenance_mode: boolean;
  maintenance_reason: string | null;
  maintenance_until: string | null;
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

export type ContainerOverview = {
  hostId: string;
  hostDisplayName: string;
  name: string;
  status: ContainerStatus;
  state: ContainerState;
  health: ContainerHealth;
  restartCount: number;
  oomKilled: boolean;
  exitCode: number | null;
  receivedAt: string;
  ageSeconds: number;
  expectedState: ContainerExpectedState | null;
  maintenanceMode: boolean;
  maintenanceActive: boolean;
  maintenanceReason: string | null;
  maintenanceUntil: string | null;
};

export type MonitoringSnapshot = {
  hosts: HostOverview[];
  containers: ContainerOverview[];
  generatedAt: string;
};

const ONLINE_THRESHOLD_SECONDS = 45;
const STALE_THRESHOLD_SECONDS = 180;
const HEARTBEAT_FETCH_LIMIT = 500;
const CONTAINER_FETCH_LIMIT = 2_000;

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

function ageSeconds(timestamp: string, now: Date): number | null {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  return Math.max(0, Math.floor((now.getTime() - milliseconds) / 1_000));
}

function determineHostStatus(age: number | null): Exclude<HostStatus, "error"> {
  if (age === null || age > STALE_THRESHOLD_SECONDS) {
    return "offline";
  }
  if (age > ONLINE_THRESHOLD_SECONDS) {
    return "stale";
  }
  return "online";
}

function isMaintenanceActive(
  expectation: ContainerExpectationRow | null,
  now: Date,
): boolean {
  if (!expectation?.maintenance_mode) {
    return false;
  }
  if (!expectation.maintenance_until) {
    return true;
  }

  const maintenanceUntil = Date.parse(expectation.maintenance_until);
  return Number.isFinite(maintenanceUntil) && maintenanceUntil > now.getTime();
}

function determineContainerStatus(
  container: ContainerSampleRow,
  age: number,
  expectation: ContainerExpectationRow | null,
  now: Date,
): ContainerStatus {
  if (age > STALE_THRESHOLD_SECONDS) {
    return "offline";
  }
  if (age > ONLINE_THRESHOLD_SECONDS) {
    return "stale";
  }
  if (isMaintenanceActive(expectation, now)) {
    return "maintenance";
  }

  switch (expectation?.expected_state) {
    case "stopped":
      return container.state === "exited" || container.state === "created"
        ? "standby"
        : "error";
    case "absent":
      return container.state === "not_found" ? "standby" : "error";
    case "running":
      if (
        container.oom_killed ||
        container.health === "unhealthy" ||
        container.state === "dead" ||
        container.state === "exited" ||
        container.state === "created" ||
        container.state === "removing" ||
        container.state === "not_found" ||
        container.state === "unknown"
      ) {
        return "error";
      }
      if (
        container.state === "restarting" ||
        container.state === "paused" ||
        container.health === "starting" ||
        container.health === "unknown"
      ) {
        return "stale";
      }
      return container.state === "running" ? "online" : "error";
    default:
      if (
        container.oom_killed ||
        container.health === "unhealthy" ||
        container.state === "dead"
      ) {
        return "error";
      }
      if (
        container.state === "restarting" ||
        container.state === "paused" ||
        container.health === "starting"
      ) {
        return "stale";
      }
      return container.state === "running" ? "online" : "offline";
  }
}

export async function getMonitoringSnapshot(): Promise<MonitoringSnapshot> {
  const now = new Date();
  const [hosts, heartbeats, containerSamples, containerExpectations] =
    await Promise.all([
      fetchSupabase<HostRow[]>(
        "/rest/v1/hosts?select=id,server_id,display_name,provider,environment,enabled&enabled=eq.true&order=display_name.asc",
      ),
      fetchSupabase<HeartbeatRow[]>(
        `/rest/v1/agent_heartbeats?select=host_id,agent_version,received_at,sent_at,cpu_count,memory_total_bytes,memory_available_bytes,disk_total_bytes,disk_available_bytes,load_average_1,load_average_5,load_average_15,uptime_seconds&order=received_at.desc&limit=${HEARTBEAT_FETCH_LIMIT}`,
      ),
      fetchSupabase<ContainerSampleRow[]>(
        `/rest/v1/container_samples?select=host_id,container_name,state,health,restart_count,oom_killed,exit_code,received_at&order=received_at.desc&limit=${CONTAINER_FETCH_LIMIT}`,
      ),
      fetchSupabase<ContainerExpectationRow[]>(
        "/rest/v1/container_expectations?select=host_id,container_name,expected_state,maintenance_mode,maintenance_reason,maintenance_until",
      ),
    ]);

  const latestByHost = new Map<string, HeartbeatRow>();
  for (const heartbeat of heartbeats) {
    if (!latestByHost.has(heartbeat.host_id)) {
      latestByHost.set(heartbeat.host_id, heartbeat);
    }
  }

  const hostNameById = new Map(hosts.map((host) => [host.id, host.display_name]));
  const latestContainerByKey = new Map<string, ContainerSampleRow>();
  for (const container of containerSamples) {
    const key = `${container.host_id}:${container.container_name}`;
    if (!latestContainerByKey.has(key) && hostNameById.has(container.host_id)) {
      latestContainerByKey.set(key, container);
    }
  }

  const expectationByKey = new Map<string, ContainerExpectationRow>();
  for (const expectation of containerExpectations) {
    expectationByKey.set(
      `${expectation.host_id}:${expectation.container_name}`,
      expectation,
    );
  }

  return {
    generatedAt: now.toISOString(),
    hosts: hosts.map((host) => {
      const heartbeat = latestByHost.get(host.id) ?? null;
      const age = heartbeat ? ageSeconds(heartbeat.received_at, now) : null;

      return {
        id: host.id,
        serverId: host.server_id,
        displayName: host.display_name,
        provider: host.provider,
        environment: host.environment,
        status: determineHostStatus(age),
        agentVersion: heartbeat?.agent_version ?? null,
        receivedAt: heartbeat?.received_at ?? null,
        sentAt: heartbeat?.sent_at ?? null,
        ageSeconds: age,
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
    containers: [...latestContainerByKey.values()]
      .map((container) => {
        const age =
          ageSeconds(container.received_at, now) ?? STALE_THRESHOLD_SECONDS + 1;
        const key = `${container.host_id}:${container.container_name}`;
        const expectation = expectationByKey.get(key) ?? null;

        return {
          hostId: container.host_id,
          hostDisplayName: hostNameById.get(container.host_id) ?? "Unknown Host",
          name: container.container_name,
          status: determineContainerStatus(container, age, expectation, now),
          state: container.state,
          health: container.health,
          restartCount: container.restart_count,
          oomKilled: container.oom_killed,
          exitCode: container.exit_code,
          receivedAt: container.received_at,
          ageSeconds: age,
          expectedState: expectation?.expected_state ?? null,
          maintenanceMode: expectation?.maintenance_mode ?? false,
          maintenanceActive: isMaintenanceActive(expectation, now),
          maintenanceReason: expectation?.maintenance_reason ?? null,
          maintenanceUntil: expectation?.maintenance_until ?? null,
        };
      })
      .sort((left, right) =>
        `${left.hostDisplayName}:${left.name}`.localeCompare(
          `${right.hostDisplayName}:${right.name}`,
          "ja",
        ),
      ),
  };
}
