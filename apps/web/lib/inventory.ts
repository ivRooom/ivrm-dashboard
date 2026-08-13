import "server-only";

import { getMinecraftOverview, type MinecraftOverallStatus } from "./minecraft";
import {
  getMonitoringSnapshot,
  type ContainerOverview,
  type ContainerStatus,
  type HostOverview,
} from "./monitoring";

export type InventoryView = "all" | "attention";
export type AgentCapability = "current" | "upgrade_recommended" | "unknown";
export type InventoryRole = "minecraft_proxy" | "minecraft_backend" | "resource" | "router" | "other";

export type InventoryContainer = ContainerOverview & {
  role: InventoryRole;
  roleLabel: string;
  managed: boolean;
  needsAttention: boolean;
  detailHref: string;
};

export type InventoryHost = HostOverview & {
  agentCapability: AgentCapability;
  containers: InventoryContainer[];
  managedContainerCount: number;
  needsAttention: boolean;
  detailHref: string;
};

export type InventoryNetworkService = {
  id: string;
  name: string;
  endpoint: string;
  protocol: "TCP" | "UDP";
  exposure: "public" | "internal";
  status: "ready" | "blocked" | "unknown" | "attention";
  note: string;
};

export type InfrastructureInventory = {
  generatedAt: string;
  view: InventoryView;
  minecraftDataAvailable: boolean;
  hosts: InventoryHost[];
  services: InventoryNetworkService[];
  summary: {
    hostCount: number;
    containerCount: number;
    attentionCount: number;
    unmanagedContainerCount: number;
    maintenanceCount: number;
    agentUpgradeRecommendedCount: number;
    cpuCoreCount: number | null;
    cpuCapacityComplete: boolean;
    memoryTotalBytes: number | null;
    memoryCapacityComplete: boolean;
    diskTotalBytes: number | null;
    diskCapacityComplete: boolean;
  };
};

const ATTENTION_CONTAINER_STATUSES = new Set<ContainerStatus>(["error", "stale", "offline"]);
const MINECRAFT_FRESH_SECONDS = 180;

export function parseInventoryView(value: string | null | undefined): InventoryView {
  return value === "attention" ? "attention" : "all";
}

function versionParts(version: string | null): [number, number, number] | null {
  if (!version) return null;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function agentCapability(version: string | null): AgentCapability {
  const parts = versionParts(version);
  if (!parts) return "unknown";
  const [major, minor] = parts;
  return major > 0 || minor >= 5 ? "current" : "upgrade_recommended";
}

function role(name: string): { role: InventoryRole; label: string } {
  switch (name) {
    case "ivrm-velocity": return { role: "minecraft_proxy", label: "Minecraft Proxy" };
    case "mc-main": return { role: "minecraft_backend", label: "Minecraft Backend" };
    case "mc-resource": return { role: "resource", label: "Resource Server" };
    case "mc-resource-router": return { role: "router", label: "Resource Router" };
    default: return { role: "other", label: "Other Workload" };
  }
}

function inventoryContainer(container: ContainerOverview, serverId: string): InventoryContainer {
  const workload = role(container.name);
  const managed = container.expectedState !== null;
  return {
    ...container,
    role: workload.role,
    roleLabel: workload.label,
    managed,
    needsAttention: ATTENTION_CONTAINER_STATUSES.has(container.status) || !managed,
    detailHref: `/containers/${encodeURIComponent(serverId)}/${encodeURIComponent(container.name)}`,
  };
}

function minecraftServiceStatus(status: MinecraftOverallStatus): InventoryNetworkService["status"] {
  if (status === "operational" || status === "maintenance") return "ready";
  if (status === "unknown") return "unknown";
  return "attention";
}

function servicesFromMinecraft(
  minecraft: Awaited<ReturnType<typeof getMinecraftOverview>> | null,
): InventoryNetworkService[] {
  if (!minecraft) {
    return [
      { id: "minecraft-public", name: "Minecraft Public", endpoint: "mc.ivrm.jp:25565", protocol: "TCP", exposure: "public", status: "unknown", note: "Minecraft Probe未受信または鮮度切れ" },
      { id: "minecraft-voice", name: "Simple Voice Chat", endpoint: "mc.ivrm.jp:24454", protocol: "UDP", exposure: "public", status: "unknown", note: "Port Binding未確認" },
      { id: "minecraft-backend", name: "Minecraft Backend", endpoint: "mc-main:25565", protocol: "TCP", exposure: "internal", status: "unknown", note: "Backend Probe未受信または鮮度切れ" },
    ];
  }
  return [
    {
      id: "minecraft-public",
      name: "Minecraft Public",
      endpoint: `${minecraft.publicEndpoint.host}:${minecraft.publicEndpoint.port}`,
      protocol: "TCP",
      exposure: "public",
      status: minecraft.publicEndpoint.published ? minecraftServiceStatus(minecraft.status) : "attention",
      note: minecraft.publicEndpoint.published ? (minecraft.publicEndpoint.version ?? "Version未取得") : "Proxy Port未公開",
    },
    {
      id: "minecraft-voice",
      name: "Simple Voice Chat",
      endpoint: `mc.ivrm.jp:${minecraft.voiceChat.port}`,
      protocol: "UDP",
      exposure: "public",
      status: minecraft.voiceChat.published ? "ready" : "attention",
      note: minecraft.voiceChat.published ? "UDP公開を確認" : "Port Binding未確認",
    },
    {
      id: "minecraft-backend",
      name: "Minecraft Backend",
      endpoint: "mc-main:25565",
      protocol: "TCP",
      exposure: "internal",
      status: minecraft.networkPolicy.backendDirectAccessBlocked ? (minecraft.backendProbe.reachable ? "ready" : "attention") : "attention",
      note: minecraft.networkPolicy.backendDirectAccessBlocked ? "Host直接公開なし" : "Backend PortがHostへ公開されています",
    },
  ];
}

function knownTotal(values: Array<number | null>): { total: number | null; complete: boolean } {
  if (values.length === 0) return { total: 0, complete: true };
  const known = values.filter((value): value is number => value !== null);
  return {
    total: known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null,
    complete: known.length === values.length,
  };
}

export async function getInfrastructureInventory(view: InventoryView): Promise<InfrastructureInventory> {
  const monitoringPromise = getMonitoringSnapshot();
  const minecraftPromise = getMinecraftOverview()
    .then((value) => ({ ok: true as const, value }))
    .catch((error: unknown) => {
      console.error("Infrastructure InventoryのMinecraft情報取得に失敗しました", error);
      return { ok: false as const, value: null };
    });
  const [monitoring, minecraft] = await Promise.all([monitoringPromise, minecraftPromise]);
  const containersByHost = new Map<string, InventoryContainer[]>();
  const serverIdByHost = new Map(monitoring.hosts.map((host) => [host.id, host.serverId]));

  for (const container of monitoring.containers) {
    const serverId = serverIdByHost.get(container.hostId);
    if (!serverId) continue;
    const current = containersByHost.get(container.hostId) ?? [];
    current.push(inventoryContainer(container, serverId));
    containersByHost.set(container.hostId, current);
  }

  const allHosts: InventoryHost[] = monitoring.hosts.map((host) => {
    const containers = containersByHost.get(host.id) ?? [];
    const capability = agentCapability(host.agentVersion);
    const hostAttention = host.status !== "online" || capability !== "current" || containers.some((container) => container.needsAttention);
    return {
      ...host,
      agentCapability: capability,
      containers,
      managedContainerCount: containers.filter((container) => container.managed).length,
      needsAttention: hostAttention,
      detailHref: `/hosts/${encodeURIComponent(host.serverId)}`,
    };
  });
  const allContainers = allHosts.flatMap((host) => host.containers);
  const hosts = view === "attention"
    ? allHosts.filter((host) => host.needsAttention).map((host) => {
        const containers = host.containers.filter((container) => container.needsAttention);
        return {
          ...host,
          containers,
          managedContainerCount: containers.filter((container) => container.managed).length,
        };
      })
    : allHosts;

  const minecraftFresh = Boolean(
    minecraft.ok &&
    minecraft.value &&
    minecraft.value.status !== "unknown" &&
    minecraft.value.checkedAt &&
    minecraft.value.ageSeconds !== null &&
    minecraft.value.ageSeconds <= MINECRAFT_FRESH_SECONDS,
  );
  const cpu = knownTotal(allHosts.map((host) => host.cpuCount));
  const memory = knownTotal(allHosts.map((host) => host.memoryTotalBytes));
  const disk = knownTotal(allHosts.map((host) => host.diskTotalBytes));

  return {
    generatedAt: monitoring.generatedAt,
    view,
    minecraftDataAvailable: minecraftFresh,
    hosts,
    services: servicesFromMinecraft(minecraftFresh ? minecraft.value : null),
    summary: {
      hostCount: allHosts.length,
      containerCount: allContainers.length,
      attentionCount: allHosts.filter((host) => host.needsAttention).length + allContainers.filter((container) => container.needsAttention).length,
      unmanagedContainerCount: allContainers.filter((container) => !container.managed).length,
      maintenanceCount: allContainers.filter((container) => container.maintenanceActive).length,
      agentUpgradeRecommendedCount: allHosts.filter((host) => host.agentCapability === "upgrade_recommended").length,
      cpuCoreCount: cpu.total,
      cpuCapacityComplete: cpu.complete,
      memoryTotalBytes: memory.total,
      memoryCapacityComplete: memory.complete,
      diskTotalBytes: disk.total,
      diskCapacityComplete: disk.complete,
    },
  };
}
