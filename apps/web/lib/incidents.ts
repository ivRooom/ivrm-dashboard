import {
  getHostMonitoringEvents,
  type HostMonitoringEvent,
} from "./host-monitoring-events";
import {
  getMonitoringEvents,
  type MonitoringEvent,
  type MonitoringEventSeverity,
  type MonitoringEventType,
} from "./monitoring-events";
import {
  getMonitoringSnapshot,
  type ContainerOverview,
  type ContainerStatus,
  type HostOverview,
  type MonitoringSnapshot,
} from "./monitoring";

export const INCIDENT_RANGE_CONFIG = {
  "24h": { label: "24時間", hours: 24 },
  "7d": { label: "7日", hours: 24 * 7 },
  "30d": { label: "30日", hours: 24 * 30 },
} as const;

export type IncidentRange = keyof typeof INCIDENT_RANGE_CONFIG;
export type IncidentSeverity = "warning" | "critical";
export type IncidentEntityType = "host" | "container";

export type ActiveIncident = {
  id: string;
  entityType: IncidentEntityType;
  severity: IncidentSeverity;
  hostId: string;
  serverId: string;
  hostDisplayName: string;
  containerName: string | null;
  currentStatus: "stale" | "offline" | "error";
  startedAt: string | null;
  durationSeconds: number | null;
  startReason: string;
  latestTransitionAt: string | null;
  latestTransition: string | null;
  relatedEventCount: number;
  exactStart: boolean;
  detailHref: string;
  eventsHref: string;
};

export type RecoveredIncident = {
  id: string;
  entityType: IncidentEntityType;
  severity: IncidentSeverity;
  hostId: string;
  serverId: string;
  hostDisplayName: string;
  containerName: string | null;
  startedAt: string;
  recoveredAt: string;
  durationSeconds: number;
  startReason: string;
  recoveryReason: string;
  relatedEventCount: number;
  detailHref: string;
  eventsHref: string;
};

export type IncidentCenterSnapshot = {
  generatedAt: string;
  range: IncidentRange;
  active: ActiveIncident[];
  recovered: RecoveredIncident[];
  summary: {
    activeCount: number;
    activeCriticalCount: number;
    activeWarningCount: number;
    recoveredCount: number;
    criticalEventCount: number;
    warningEventCount: number;
    exactRecoveryCount: number;
    medianRecoverySeconds: number | null;
    longestRecoverySeconds: number | null;
    affectedEntityCount: number;
    latestRecoveredAt: string | null;
  };
};

type SignalName = "state" | "health" | "exit";

type OpenSignal = {
  startedAt: string;
  severity: IncidentSeverity;
  startEvent: MonitoringEvent;
  eventCount: number;
};

type OpenEpisode = {
  startedAt: string;
  severity: IncidentSeverity;
  startEvent: MonitoringEvent;
  activeSignals: Set<SignalName>;
  eventCount: number;
  lastEvent: MonitoringEvent;
};

const ACTIVE_HOST_STATUSES = new Set(["stale", "offline"] as const);
const ACTIVE_CONTAINER_STATUSES = new Set(["error", "stale", "offline"] as const);
const SIGNAL_TYPES = new Map<MonitoringEventType, SignalName>([
  ["state_changed", "state"],
  ["health_changed", "health"],
  ["exit_code_changed", "exit"],
]);

export function parseIncidentRange(value: string | null | undefined): IncidentRange {
  return value && value in INCIDENT_RANGE_CONFIG
    ? (value as IncidentRange)
    : "24h";
}

function entityKey(hostId: string, containerName?: string | null): string {
  return containerName ? `${hostId}:${containerName}` : `host:${hostId}`;
}

function severityRank(severity: IncidentSeverity): number {
  return severity === "critical" ? 2 : 1;
}

function maxSeverity(
  left: IncidentSeverity,
  right: IncidentSeverity,
): IncidentSeverity {
  return severityRank(right) > severityRank(left) ? right : left;
}

function incidentSeverity(
  severity: MonitoringEventSeverity,
): IncidentSeverity | null {
  return severity === "critical" || severity === "warning" ? severity : null;
}

function signalName(event: MonitoringEvent): SignalName | null {
  return SIGNAL_TYPES.get(event.eventType) ?? null;
}

function eventTransition(event: MonitoringEvent): string {
  switch (event.eventType) {
    case "state_changed":
      return `State ${event.fromValue ?? "不明"} → ${event.toValue ?? "不明"}`;
    case "health_changed":
      return `Health ${event.fromValue ?? "不明"} → ${event.toValue ?? "不明"}`;
    case "exit_code_changed":
      return `ExitCode ${event.fromValue ?? "不明"} → ${event.toValue ?? "不明"}`;
    case "restart_count_increased":
      return `RestartCount ${event.fromValue ?? "不明"} → ${event.toValue ?? "不明"}`;
    case "oom_killed":
      return "OOMKilledを検知";
    case "maintenance_started":
      return "メンテナンス開始";
    case "maintenance_ended":
      return "メンテナンス終了";
  }
}

function hostEventTransition(event: HostMonitoringEvent): string {
  switch (event.eventType) {
    case "host_reboot_detected":
      return "OS Uptime低下を検知";
    case "agent_version_changed":
      return `Agent ${event.fromValue ?? "不明"} → ${event.toValue ?? "不明"}`;
    case "heartbeat_gap_detected":
      return `Heartbeat gap ${event.numericValue ?? 0}秒`;
  }
}

function eventByEntity(events: MonitoringEvent[]): Map<string, MonitoringEvent[]> {
  const grouped = new Map<string, MonitoringEvent[]>();
  for (const event of events) {
    const key = entityKey(event.hostId, event.containerName);
    const current = grouped.get(key) ?? [];
    current.push(event);
    grouped.set(key, current);
  }
  for (const current of grouped.values()) {
    current.sort((left, right) =>
      Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.id - right.id,
    );
  }
  return grouped;
}

function hostEventsByEntity(events: HostMonitoringEvent[]): Map<string, HostMonitoringEvent[]> {
  const grouped = new Map<string, HostMonitoringEvent[]>();
  for (const event of events) {
    const key = entityKey(event.hostId);
    const current = grouped.get(key) ?? [];
    current.push(event);
    grouped.set(key, current);
  }
  for (const current of grouped.values()) {
    current.sort((left, right) =>
      Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.id - right.id,
    );
  }
  return grouped;
}

function deriveOpenSignals(events: MonitoringEvent[]): Map<SignalName, OpenSignal> {
  const signals = new Map<SignalName, OpenSignal>();

  for (const event of events) {
    const signal = signalName(event);
    if (!signal) continue;

    const startSeverity = incidentSeverity(event.severity);
    if (startSeverity) {
      const open = signals.get(signal);
      if (open) {
        open.severity = maxSeverity(open.severity, startSeverity);
        open.eventCount += 1;
      } else {
        signals.set(signal, {
          startedAt: event.occurredAt,
          severity: startSeverity,
          startEvent: event,
          eventCount: 1,
        });
      }
      continue;
    }

    if (event.severity === "recovery") {
      signals.delete(signal);
    }
  }

  return signals;
}

function currentStateIsIncident(container: ContainerOverview): boolean {
  switch (container.expectedState) {
    case "running":
      return [
        "created",
        "paused",
        "restarting",
        "removing",
        "exited",
        "dead",
        "unknown",
        "not_found",
      ].includes(container.state);
    case "stopped":
      return container.state !== "exited" && container.state !== "created";
    case "absent":
      return container.state !== "not_found";
    default:
      return container.state !== "running";
  }
}

function currentHealthIsIncident(container: ContainerOverview): boolean {
  if (container.expectedState === "stopped" || container.expectedState === "absent") {
    return false;
  }
  if (container.expectedState === "running") {
    return ["unhealthy", "starting", "unknown"].includes(container.health);
  }
  return container.health === "unhealthy" || container.health === "starting";
}

function fallbackSeverity(status: ContainerStatus | HostOverview["status"]): IncidentSeverity {
  return status === "stale" ? "warning" : "critical";
}

function durationSeconds(startedAt: string | null, endedAt: string): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.floor((end - start) / 1_000);
}

function containerDetailHref(
  serverId: string,
  containerName: string,
  range: IncidentRange,
): string {
  return `/containers/${encodeURIComponent(serverId)}/${encodeURIComponent(containerName)}?range=${range}`;
}

function containerEventsHref(
  serverId: string,
  containerName: string,
  range: IncidentRange,
): string {
  return `/events?range=${range}&target=${encodeURIComponent(`${serverId}/${containerName}`)}`;
}

function hostDetailHref(serverId: string, range: IncidentRange): string {
  return `/hosts/${encodeURIComponent(serverId)}?range=${range}`;
}

function deriveActiveContainerIncidents(
  snapshot: MonitoringSnapshot,
  groupedEvents: Map<string, MonitoringEvent[]>,
  range: IncidentRange,
): ActiveIncident[] {
  const hostById = new Map(snapshot.hosts.map((host) => [host.id, host]));
  const active: ActiveIncident[] = [];

  for (const container of snapshot.containers) {
    if (!ACTIVE_CONTAINER_STATUSES.has(container.status as "error" | "stale" | "offline")) {
      continue;
    }
    if (container.maintenanceActive) {
      continue;
    }

    const host = hostById.get(container.hostId);
    if (!host) continue;

    const events = groupedEvents.get(entityKey(container.hostId, container.name)) ?? [];
    const signals = deriveOpenSignals(events);
    const candidates: OpenSignal[] = [];

    if (currentStateIsIncident(container)) {
      const stateSignal = signals.get("state");
      if (stateSignal) candidates.push(stateSignal);
    }
    if (currentHealthIsIncident(container)) {
      const healthSignal = signals.get("health");
      if (healthSignal) candidates.push(healthSignal);
    }
    if (container.oomKilled) {
      const oomEvent = [...events]
        .reverse()
        .find((event) => event.eventType === "oom_killed" && event.severity === "critical");
      if (oomEvent) {
        candidates.push({
          startedAt: oomEvent.occurredAt,
          severity: "critical",
          startEvent: oomEvent,
          eventCount: 1,
        });
      }
    }

    candidates.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
    const first = candidates[0] ?? null;
    const severity = candidates.reduce<IncidentSeverity>(
      (current, candidate) => maxSeverity(current, candidate.severity),
      fallbackSeverity(container.status),
    );
    const startedAt = first?.startedAt ?? null;
    const latestEvent = [...events]
      .reverse()
      .find((event) => !startedAt || Date.parse(event.occurredAt) >= Date.parse(startedAt)) ?? null;
    const relatedEventCount = startedAt
      ? events.filter((event) => Date.parse(event.occurredAt) >= Date.parse(startedAt)).length
      : events.length;

    active.push({
      id: `active-container:${container.hostId}:${container.name}`,
      entityType: "container",
      severity,
      hostId: container.hostId,
      serverId: host.serverId,
      hostDisplayName: host.displayName,
      containerName: container.name,
      currentStatus: container.status as "error" | "stale" | "offline",
      startedAt,
      durationSeconds: durationSeconds(startedAt, snapshot.generatedAt),
      startReason: first ? eventTransition(first.startEvent) : "開始Transitionを30日以内に特定できません",
      latestTransitionAt: latestEvent?.occurredAt ?? null,
      latestTransition: latestEvent ? eventTransition(latestEvent) : null,
      relatedEventCount,
      exactStart: first !== null,
      detailHref: containerDetailHref(host.serverId, container.name, range),
      eventsHref: containerEventsHref(host.serverId, container.name, range),
    });
  }

  return active;
}

function deriveActiveHostIncidents(
  snapshot: MonitoringSnapshot,
  groupedEvents: Map<string, HostMonitoringEvent[]>,
  range: IncidentRange,
): ActiveIncident[] {
  const active: ActiveIncident[] = [];

  for (const host of snapshot.hosts) {
    if (!ACTIVE_HOST_STATUSES.has(host.status as "stale" | "offline")) continue;

    const events = groupedEvents.get(entityKey(host.id)) ?? [];
    const latestEvent = events.at(-1) ?? null;
    active.push({
      id: `active-host:${host.id}`,
      entityType: "host",
      severity: fallbackSeverity(host.status),
      hostId: host.id,
      serverId: host.serverId,
      hostDisplayName: host.displayName,
      containerName: null,
      currentStatus: host.status,
      startedAt: null,
      durationSeconds: null,
      startReason: "Heartbeat停止中の開始時刻は復旧後まで確定しません",
      latestTransitionAt: latestEvent?.occurredAt ?? null,
      latestTransition: latestEvent ? hostEventTransition(latestEvent) : null,
      relatedEventCount: events.length,
      exactStart: false,
      detailHref: hostDetailHref(host.serverId, range),
      eventsHref: hostDetailHref(host.serverId, range),
    });
  }

  return active;
}

function deriveRecoveredContainerIncidents(
  events: MonitoringEvent[],
  rangeStart: number,
  range: IncidentRange,
): RecoveredIncident[] {
  const grouped = eventByEntity(events);
  const recovered: RecoveredIncident[] = [];

  for (const entityEvents of grouped.values()) {
    const signals = new Set<SignalName>();
    let episode: OpenEpisode | null = null;

    for (const event of entityEvents) {
      const signal = signalName(event);
      if (!signal) continue;
      const startSeverity = incidentSeverity(event.severity);

      if (startSeverity) {
        const signalWasOpen = signals.has(signal);
        signals.add(signal);
        if (!episode) {
          episode = {
            startedAt: event.occurredAt,
            severity: startSeverity,
            startEvent: event,
            activeSignals: signals,
            eventCount: 1,
            lastEvent: event,
          };
        } else {
          episode.severity = maxSeverity(episode.severity, startSeverity);
          episode.eventCount += 1;
          episode.lastEvent = event;
          if (!signalWasOpen) episode.activeSignals = signals;
        }
        continue;
      }

      if (event.severity !== "recovery" || !signals.has(signal) || !episode) {
        continue;
      }

      signals.delete(signal);
      episode.eventCount += 1;
      episode.lastEvent = event;
      episode.activeSignals = signals;

      if (signals.size > 0) continue;

      const start = Date.parse(episode.startedAt);
      const recoveredAt = Date.parse(event.occurredAt);
      if (
        Number.isFinite(start) &&
        Number.isFinite(recoveredAt) &&
        recoveredAt >= start &&
        recoveredAt >= rangeStart
      ) {
        recovered.push({
          id: `recovered-container:${episode.startEvent.id}:${event.id}`,
          entityType: "container",
          severity: episode.severity,
          hostId: event.hostId,
          serverId: event.serverId,
          hostDisplayName: event.hostDisplayName,
          containerName: event.containerName,
          startedAt: episode.startedAt,
          recoveredAt: event.occurredAt,
          durationSeconds: Math.floor((recoveredAt - start) / 1_000),
          startReason: eventTransition(episode.startEvent),
          recoveryReason: eventTransition(event),
          relatedEventCount: episode.eventCount,
          detailHref: containerDetailHref(event.serverId, event.containerName, range),
          eventsHref: containerEventsHref(event.serverId, event.containerName, range),
        });
      }
      episode = null;
    }
  }

  return recovered;
}

function deriveRecoveredHostGaps(
  events: HostMonitoringEvent[],
  rangeStart: number,
  range: IncidentRange,
): RecoveredIncident[] {
  return events.flatMap((event): RecoveredIncident[] => {
    if (
      event.eventType !== "heartbeat_gap_detected" ||
      event.numericValue === null ||
      event.numericValue <= 0 ||
      Date.parse(event.occurredAt) < rangeStart
    ) {
      return [];
    }
    const recoveredAt = Date.parse(event.occurredAt);
    if (!Number.isFinite(recoveredAt)) return [];
    const startedAt = new Date(recoveredAt - event.numericValue * 1_000).toISOString();
    return [{
      id: `recovered-host-gap:${event.id}`,
      entityType: "host",
      severity: "warning",
      hostId: event.hostId,
      serverId: event.serverId,
      hostDisplayName: event.hostDisplayName,
      containerName: null,
      startedAt,
      recoveredAt: event.occurredAt,
      durationSeconds: event.numericValue,
      startReason: "Heartbeat受信が180秒を超えて途絶",
      recoveryReason: "Heartbeat受信を再開",
      relatedEventCount: 1,
      detailHref: hostDetailHref(event.serverId, range),
      eventsHref: hostDetailHref(event.serverId, range),
    }];
  });
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const left = sorted[middle - 1];
  const right = sorted[middle];
  return left === undefined || right === undefined ? null : Math.floor((left + right) / 2);
}

export async function getIncidentCenterSnapshot(
  range: IncidentRange,
): Promise<IncidentCenterSnapshot> {
  const [snapshot, containerEvents, hostEvents] = await Promise.all([
    getMonitoringSnapshot(),
    getMonitoringEvents({ range: "30d" }),
    getHostMonitoringEvents("30d"),
  ]);

  const rangeStart =
    Date.parse(snapshot.generatedAt) - INCIDENT_RANGE_CONFIG[range].hours * 3_600_000;
  const groupedContainerEvents = eventByEntity(containerEvents);
  const groupedHostEvents = hostEventsByEntity(hostEvents);

  const active = [
    ...deriveActiveHostIncidents(snapshot, groupedHostEvents, range),
    ...deriveActiveContainerIncidents(snapshot, groupedContainerEvents, range),
  ].sort((left, right) => {
    const severityDiff = severityRank(right.severity) - severityRank(left.severity);
    if (severityDiff !== 0) return severityDiff;
    const leftStart = left.startedAt ? Date.parse(left.startedAt) : Number.POSITIVE_INFINITY;
    const rightStart = right.startedAt ? Date.parse(right.startedAt) : Number.POSITIVE_INFINITY;
    return leftStart - rightStart;
  });

  const recovered = [
    ...deriveRecoveredContainerIncidents(containerEvents, rangeStart, range),
    ...deriveRecoveredHostGaps(hostEvents, rangeStart, range),
  ].sort((left, right) => Date.parse(right.recoveredAt) - Date.parse(left.recoveredAt));

  const containerEventsInRange = containerEvents.filter(
    (event) => Date.parse(event.occurredAt) >= rangeStart,
  );
  const hostEventsInRange = hostEvents.filter(
    (event) => Date.parse(event.occurredAt) >= rangeStart,
  );
  const criticalEventCount = containerEventsInRange.filter(
    (event) => event.severity === "critical",
  ).length;
  const warningEventCount =
    containerEventsInRange.filter((event) => event.severity === "warning").length +
    hostEventsInRange.filter((event) => event.severity === "warning").length;
  const recoveryDurations = recovered.map((incident) => incident.durationSeconds);
  const affectedEntities = new Set<string>();
  for (const incident of active) {
    affectedEntities.add(entityKey(incident.hostId, incident.containerName));
  }
  for (const incident of recovered) {
    affectedEntities.add(entityKey(incident.hostId, incident.containerName));
  }

  return {
    generatedAt: snapshot.generatedAt,
    range,
    active,
    recovered,
    summary: {
      activeCount: active.length,
      activeCriticalCount: active.filter((incident) => incident.severity === "critical").length,
      activeWarningCount: active.filter((incident) => incident.severity === "warning").length,
      recoveredCount: recovered.length,
      criticalEventCount,
      warningEventCount,
      exactRecoveryCount: recovered.length,
      medianRecoverySeconds: median(recoveryDurations),
      longestRecoverySeconds: recoveryDurations.length ? Math.max(...recoveryDurations) : null,
      affectedEntityCount: affectedEntities.size,
      latestRecoveredAt: recovered[0]?.recoveredAt ?? null,
    },
  };
}
