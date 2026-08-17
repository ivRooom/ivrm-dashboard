import {
  HISTORY_RANGE_CONFIG,
  type HistoryRange,
} from "./history";
import {
  getHostMonitoringEvents,
  type HostMonitoringEvent,
} from "./host-monitoring-events";
import {
  getMonitoringEvents,
  getMonitoringIncidentContext,
  type MonitoringEvent,
  type MonitoringEventType,
} from "./monitoring-events";
import {
  getMonitoringSnapshot,
  type ContainerOverview,
  type HostOverview,
} from "./monitoring";

export type HistoryStatusOverlayKind =
  | "stale"
  | "offline"
  | "error"
  | "maintenance";

export type HistoryStatusOverlayRegion = {
  id: string;
  startAt: string;
  endAt: string;
  label: string;
  kind: HistoryStatusOverlayKind;
  entityType: "host" | "container";
  hostId: string;
  containerName: string | null;
};

export type HistoryStatusOverlaySnapshot = {
  generatedAt: string;
  hostRegions: HistoryStatusOverlayRegion[];
  containerRegions: HistoryStatusOverlayRegion[];
};

type IncidentSignal = "state" | "health" | "exit";
type IncidentOverlayKind = "stale" | "error";

const ONLINE_THRESHOLD_MS = 45_000;
const OFFLINE_THRESHOLD_MS = 180_000;
const SIGNAL_BY_EVENT = new Map<MonitoringEventType, IncidentSignal>([
  ["state_changed", "state"],
  ["health_changed", "health"],
  ["exit_code_changed", "exit"],
]);

function contextRange(range: HistoryRange): HistoryRange {
  return range === "7d" || range === "30d" ? "30d" : "7d";
}

function entityKey(hostId: string, containerName: string | null = null): string {
  return containerName ? `${hostId}:${containerName}` : `host:${hostId}`;
}

function regionLabel(
  hostDisplayName: string,
  kind: HistoryStatusOverlayKind,
  containerName: string | null = null,
): string {
  const kindLabel: Record<HistoryStatusOverlayKind, string> = {
    stale: "Stale",
    offline: "Offline",
    error: "Error",
    maintenance: "Maintenance",
  };
  return containerName
    ? `${containerName} / ${hostDisplayName} / ${kindLabel[kind]}`
    : `${hostDisplayName} / ${kindLabel[kind]}`;
}

function createRegion(
  input: Omit<HistoryStatusOverlayRegion, "startAt" | "endAt"> & {
    startMs: number;
    endMs: number;
  },
  rangeStartMs: number,
  rangeEndMs: number,
): HistoryStatusOverlayRegion | null {
  const startMs = Math.max(input.startMs, rangeStartMs);
  const endMs = Math.min(input.endMs, rangeEndMs);
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return null;
  }

  return {
    id: input.id,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    label: input.label,
    kind: input.kind,
    entityType: input.entityType,
    hostId: input.hostId,
    containerName: input.containerName,
  };
}

function pushRegion(
  regions: HistoryStatusOverlayRegion[],
  input: Omit<HistoryStatusOverlayRegion, "startAt" | "endAt"> & {
    startMs: number;
    endMs: number;
  },
  rangeStartMs: number,
  rangeEndMs: number,
): void {
  const region = createRegion(input, rangeStartMs, rangeEndMs);
  if (region) regions.push(region);
}

function hostGapRegions(
  events: HostMonitoringEvent[],
  rangeStartMs: number,
  rangeEndMs: number,
): HistoryStatusOverlayRegion[] {
  const regions: HistoryStatusOverlayRegion[] = [];

  for (const event of events) {
    if (
      event.eventType !== "heartbeat_gap_detected" ||
      event.numericValue === null ||
      event.numericValue <= 45
    ) {
      continue;
    }

    const recoveredMs = Date.parse(event.occurredAt);
    if (!Number.isFinite(recoveredMs)) continue;

    const gapStartMs = recoveredMs - event.numericValue * 1_000;
    const staleStartMs = gapStartMs + ONLINE_THRESHOLD_MS;
    const offlineStartMs = gapStartMs + OFFLINE_THRESHOLD_MS;

    pushRegion(
      regions,
      {
        id: `host-gap-stale:${event.id}`,
        startMs: staleStartMs,
        endMs: Math.min(offlineStartMs, recoveredMs),
        label: regionLabel(event.hostDisplayName, "stale"),
        kind: "stale",
        entityType: "host",
        hostId: event.hostId,
        containerName: null,
      },
      rangeStartMs,
      rangeEndMs,
    );

    if (recoveredMs > offlineStartMs) {
      pushRegion(
        regions,
        {
          id: `host-gap-offline:${event.id}`,
          startMs: offlineStartMs,
          endMs: recoveredMs,
          label: regionLabel(event.hostDisplayName, "offline"),
          kind: "offline",
          entityType: "host",
          hostId: event.hostId,
          containerName: null,
        },
        rangeStartMs,
        rangeEndMs,
      );
    }
  }

  return regions;
}

function activeHostRegions(
  hosts: HostOverview[],
  generatedAt: string,
  rangeStartMs: number,
  rangeEndMs: number,
): HistoryStatusOverlayRegion[] {
  const regions: HistoryStatusOverlayRegion[] = [];
  const generatedMs = Date.parse(generatedAt);

  for (const host of hosts) {
    if (
      (host.status !== "stale" && host.status !== "offline") ||
      !host.receivedAt
    ) {
      continue;
    }
    const lastHeartbeatMs = Date.parse(host.receivedAt);
    if (!Number.isFinite(lastHeartbeatMs) || !Number.isFinite(generatedMs)) {
      continue;
    }

    const staleStartMs = lastHeartbeatMs + ONLINE_THRESHOLD_MS;
    const offlineStartMs = lastHeartbeatMs + OFFLINE_THRESHOLD_MS;
    pushRegion(
      regions,
      {
        id: `active-host-stale:${host.id}`,
        startMs: staleStartMs,
        endMs:
          host.status === "offline"
            ? Math.min(offlineStartMs, generatedMs)
            : generatedMs,
        label: regionLabel(host.displayName, "stale"),
        kind: "stale",
        entityType: "host",
        hostId: host.id,
        containerName: null,
      },
      rangeStartMs,
      rangeEndMs,
    );

    if (host.status === "offline") {
      pushRegion(
        regions,
        {
          id: `active-host-offline:${host.id}`,
          startMs: offlineStartMs,
          endMs: generatedMs,
          label: regionLabel(host.displayName, "offline"),
          kind: "offline",
          entityType: "host",
          hostId: host.id,
          containerName: null,
        },
        rangeStartMs,
        rangeEndMs,
      );
    }
  }

  return regions;
}

function signalName(event: MonitoringEvent): IncidentSignal | null {
  return SIGNAL_BY_EVENT.get(event.eventType) ?? null;
}

function resolvesSignal(event: MonitoringEvent): boolean {
  if (event.severity === "recovery") return true;
  if (event.eventType === "health_changed") return event.toValue === "healthy";
  if (event.eventType === "exit_code_changed") {
    return event.toValue !== null && Number(event.toValue) === 0;
  }
  if (event.eventType !== "state_changed") return false;
  if (
    event.expectedState === "stopped" &&
    (event.toValue === "exited" || event.toValue === "created")
  ) {
    return true;
  }
  if (event.expectedState === "absent" && event.toValue === "not_found") {
    return true;
  }
  return (
    event.expectedState !== "stopped" &&
    event.expectedState !== "absent" &&
    event.toValue === "running"
  );
}

function eventOverlayKind(event: MonitoringEvent): IncidentOverlayKind | null {
  if (event.severity === "critical") return "error";
  if (event.severity === "warning") return "stale";
  return null;
}

function strongestSignalKind(
  signals: Map<IncidentSignal, IncidentOverlayKind>,
): IncidentOverlayKind | null {
  for (const kind of signals.values()) {
    if (kind === "error") return "error";
  }
  return signals.size > 0 ? "stale" : null;
}

function mergeUniqueContainerEvents(
  contextEvents: MonitoringEvent[],
  rangeEvents: MonitoringEvent[],
): MonitoringEvent[] {
  const byId = new Map<number, MonitoringEvent>();
  for (const event of contextEvents) byId.set(event.id, event);
  for (const event of rangeEvents) byId.set(event.id, event);
  return [...byId.values()];
}

function groupedContainerEvents(
  events: MonitoringEvent[],
): Map<string, MonitoringEvent[]> {
  const grouped = new Map<string, MonitoringEvent[]>();
  for (const event of events) {
    const key = entityKey(event.hostId, event.containerName);
    const current = grouped.get(key) ?? [];
    current.push(event);
    grouped.set(key, current);
  }
  for (const current of grouped.values()) {
    current.sort(
      (left, right) =>
        Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
        left.id - right.id,
    );
  }
  return grouped;
}

function containerIncidentRegions(
  events: MonitoringEvent[],
  containers: ContainerOverview[],
  generatedAt: string,
  rangeStartMs: number,
  rangeEndMs: number,
): HistoryStatusOverlayRegion[] {
  const regions: HistoryStatusOverlayRegion[] = [];
  const grouped = groupedContainerEvents(events);
  const currentByKey = new Map(
    containers.map((container) => [entityKey(container.hostId, container.name), container]),
  );
  const generatedMs = Date.parse(generatedAt);

  for (const [key, entityEvents] of grouped) {
    const firstEvent = entityEvents[0];
    if (!firstEvent) continue;

    const activeSignals = new Map<IncidentSignal, IncidentOverlayKind>();
    let bandKind: IncidentOverlayKind | null = null;
    let bandStartMs: number | null = null;
    let expectedState: MonitoringEvent["expectedState"] | undefined;
    let hasExpectedState = false;

    for (const event of entityEvents) {
      const eventMs = Date.parse(event.occurredAt);
      if (!Number.isFinite(eventMs)) continue;
      const previousKind = strongestSignalKind(activeSignals);

      if (hasExpectedState && event.expectedState !== expectedState) {
        activeSignals.clear();
      }
      expectedState = event.expectedState;
      hasExpectedState = true;

      const signal = signalName(event);
      if (signal) {
        const nextSignalKind = eventOverlayKind(event);
        if (nextSignalKind) {
          activeSignals.set(signal, nextSignalKind);
        } else if (resolvesSignal(event)) {
          activeSignals.delete(signal);
        }
      }

      const nextKind = strongestSignalKind(activeSignals);
      if (previousKind === nextKind) {
        if (nextKind && bandStartMs === null) {
          bandStartMs = eventMs;
          bandKind = nextKind;
        }
        continue;
      }

      if (previousKind && bandStartMs !== null) {
        pushRegion(
          regions,
          {
            id: `container-incident:${key}:${bandStartMs}:${eventMs}:${previousKind}`,
            startMs: bandStartMs,
            endMs: eventMs,
            label: regionLabel(
              firstEvent.hostDisplayName,
              previousKind,
              firstEvent.containerName,
            ),
            kind: previousKind,
            entityType: "container",
            hostId: firstEvent.hostId,
            containerName: firstEvent.containerName,
          },
          rangeStartMs,
          rangeEndMs,
        );
      }

      bandStartMs = nextKind ? eventMs : null;
      bandKind = nextKind;
    }

    const current = currentByKey.get(key);
    if (
      !bandKind ||
      bandStartMs === null ||
      !current ||
      current.maintenanceActive ||
      !Number.isFinite(generatedMs)
    ) {
      continue;
    }

    let bandEndMs: number | null = null;
    if (current.status === "error") {
      bandEndMs = generatedMs;
    } else if (current.status === "stale" || current.status === "offline") {
      const receivedMs = Date.parse(current.receivedAt);
      if (Number.isFinite(receivedMs)) {
        bandEndMs = Math.min(generatedMs, receivedMs + ONLINE_THRESHOLD_MS);
      }
    }

    if (bandEndMs !== null) {
      pushRegion(
        regions,
        {
          id: `active-container-incident:${key}:${bandStartMs}:${bandKind}`,
          startMs: bandStartMs,
          endMs: bandEndMs,
          label: regionLabel(current.hostDisplayName, bandKind, current.name),
          kind: bandKind,
          entityType: "container",
          hostId: current.hostId,
          containerName: current.name,
        },
        rangeStartMs,
        rangeEndMs,
      );
    }
  }

  for (const container of containers) {
    if (container.maintenanceActive || container.status !== "error") continue;

    const key = entityKey(container.hostId, container.name);
    const alreadyCovered = regions.some(
      (region) =>
        region.entityType === "container" &&
        entityKey(region.hostId, region.containerName) === key &&
        region.kind === "error" &&
        Date.parse(region.endAt) >= Date.parse(generatedAt) - 1_000,
    );
    if (alreadyCovered) continue;

    const receivedMs = Date.parse(container.receivedAt);
    if (!Number.isFinite(receivedMs) || !Number.isFinite(generatedMs)) continue;
    pushRegion(
      regions,
      {
        id: `active-container-fallback:${key}`,
        startMs: receivedMs,
        endMs: generatedMs,
        label: regionLabel(container.hostDisplayName, "error", container.name),
        kind: "error",
        entityType: "container",
        hostId: container.hostId,
        containerName: container.name,
      },
      rangeStartMs,
      rangeEndMs,
    );
  }

  return regions;
}

function containerFreshnessRegions(
  containers: ContainerOverview[],
  generatedAt: string,
  rangeStartMs: number,
  rangeEndMs: number,
): HistoryStatusOverlayRegion[] {
  const regions: HistoryStatusOverlayRegion[] = [];
  const generatedMs = Date.parse(generatedAt);

  for (const container of containers) {
    if (container.status !== "stale" && container.status !== "offline") continue;

    const receivedMs = Date.parse(container.receivedAt);
    if (!Number.isFinite(receivedMs) || !Number.isFinite(generatedMs)) continue;
    const staleStartMs = receivedMs + ONLINE_THRESHOLD_MS;
    const offlineStartMs = receivedMs + OFFLINE_THRESHOLD_MS;

    pushRegion(
      regions,
      {
        id: `active-container-stale:${container.hostId}:${container.name}`,
        startMs: staleStartMs,
        endMs:
          container.status === "offline"
            ? Math.min(offlineStartMs, generatedMs)
            : generatedMs,
        label: regionLabel(container.hostDisplayName, "stale", container.name),
        kind: "stale",
        entityType: "container",
        hostId: container.hostId,
        containerName: container.name,
      },
      rangeStartMs,
      rangeEndMs,
    );

    if (container.status === "offline") {
      pushRegion(
        regions,
        {
          id: `active-container-offline:${container.hostId}:${container.name}`,
          startMs: offlineStartMs,
          endMs: generatedMs,
          label: regionLabel(container.hostDisplayName, "offline", container.name),
          kind: "offline",
          entityType: "container",
          hostId: container.hostId,
          containerName: container.name,
        },
        rangeStartMs,
        rangeEndMs,
      );
    }
  }

  return regions;
}

function maintenanceRegions(
  events: MonitoringEvent[],
  containers: ContainerOverview[],
  generatedAt: string,
  rangeStartMs: number,
  rangeEndMs: number,
): HistoryStatusOverlayRegion[] {
  const regions: HistoryStatusOverlayRegion[] = [];
  const grouped = groupedContainerEvents(events);
  const currentByKey = new Map(
    containers.map((container) => [entityKey(container.hostId, container.name), container]),
  );
  const generatedMs = Date.parse(generatedAt);

  for (const [key, entityEvents] of grouped) {
    const firstEvent = entityEvents[0];
    if (!firstEvent) continue;
    let startedMs: number | null = null;

    for (const event of entityEvents) {
      const eventMs = Date.parse(event.occurredAt);
      if (!Number.isFinite(eventMs)) continue;
      if (event.eventType === "maintenance_started") {
        startedMs = startedMs ?? eventMs;
        continue;
      }
      if (event.eventType !== "maintenance_ended") continue;

      const safeStartMs = startedMs ?? rangeStartMs;
      pushRegion(
        regions,
        {
          id: `maintenance:${key}:${safeStartMs}:${event.id}`,
          startMs: safeStartMs,
          endMs: eventMs,
          label: regionLabel(
            firstEvent.hostDisplayName,
            "maintenance",
            firstEvent.containerName,
          ),
          kind: "maintenance",
          entityType: "container",
          hostId: firstEvent.hostId,
          containerName: firstEvent.containerName,
        },
        rangeStartMs,
        rangeEndMs,
      );
      startedMs = null;
    }

    const current = currentByKey.get(key);
    if (current?.maintenanceActive && Number.isFinite(generatedMs)) {
      pushRegion(
        regions,
        {
          id: `active-maintenance:${key}`,
          startMs: startedMs ?? rangeStartMs,
          endMs: generatedMs,
          label: regionLabel(current.hostDisplayName, "maintenance", current.name),
          kind: "maintenance",
          entityType: "container",
          hostId: current.hostId,
          containerName: current.name,
        },
        rangeStartMs,
        rangeEndMs,
      );
    }
  }

  for (const container of containers) {
    if (!container.maintenanceActive) continue;
    const key = entityKey(container.hostId, container.name);
    const alreadyCovered = regions.some(
      (region) =>
        region.kind === "maintenance" &&
        entityKey(region.hostId, region.containerName) === key &&
        Date.parse(region.endAt) >= Date.parse(generatedAt) - 1_000,
    );
    if (alreadyCovered || !Number.isFinite(generatedMs)) continue;

    pushRegion(
      regions,
      {
        id: `active-maintenance-fallback:${key}`,
        startMs: rangeStartMs,
        endMs: generatedMs,
        label: regionLabel(
          container.hostDisplayName,
          "maintenance",
          container.name,
        ),
        kind: "maintenance",
        entityType: "container",
        hostId: container.hostId,
        containerName: container.name,
      },
      rangeStartMs,
      rangeEndMs,
    );
  }

  return regions;
}

function mergeRegions(
  regions: HistoryStatusOverlayRegion[],
): HistoryStatusOverlayRegion[] {
  const sorted = [...regions].sort(
    (left, right) =>
      left.entityType.localeCompare(right.entityType) ||
      left.hostId.localeCompare(right.hostId) ||
      (left.containerName ?? "").localeCompare(right.containerName ?? "") ||
      left.kind.localeCompare(right.kind) ||
      Date.parse(left.startAt) - Date.parse(right.startAt),
  );
  const merged: HistoryStatusOverlayRegion[] = [];

  for (const region of sorted) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.entityType === region.entityType &&
      previous.hostId === region.hostId &&
      previous.containerName === region.containerName &&
      previous.kind === region.kind &&
      Date.parse(region.startAt) <= Date.parse(previous.endAt) + 1_000
    ) {
      previous.endAt = new Date(
        Math.max(Date.parse(previous.endAt), Date.parse(region.endAt)),
      ).toISOString();
      continue;
    }
    merged.push({ ...region });
  }

  return merged.sort(
    (left, right) => Date.parse(left.startAt) - Date.parse(right.startAt),
  );
}

export async function getHistoryStatusOverlays(
  range: HistoryRange,
): Promise<HistoryStatusOverlaySnapshot> {
  const snapshot = await getMonitoringSnapshot();
  const rangeEndMs = Date.parse(snapshot.generatedAt);
  const rangeStartMs =
    rangeEndMs - HISTORY_RANGE_CONFIG[range].hours * 60 * 60 * 1_000;
  if (!Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs)) {
    throw new Error("履歴Overlayの期間境界が不正です");
  }

  const eventRange = contextRange(range);
  const [containerEvents, containerContext, hostEvents] = await Promise.all([
    getMonitoringEvents({ range: eventRange }),
    getMonitoringIncidentContext(new Date(rangeStartMs).toISOString()),
    getHostMonitoringEvents(eventRange),
  ]);
  const incidentContainerEvents = mergeUniqueContainerEvents(
    containerContext,
    containerEvents,
  );

  return {
    generatedAt: snapshot.generatedAt,
    hostRegions: mergeRegions([
      ...hostGapRegions(hostEvents, rangeStartMs, rangeEndMs),
      ...activeHostRegions(
        snapshot.hosts,
        snapshot.generatedAt,
        rangeStartMs,
        rangeEndMs,
      ),
    ]),
    containerRegions: mergeRegions([
      ...containerIncidentRegions(
        incidentContainerEvents,
        snapshot.containers,
        snapshot.generatedAt,
        rangeStartMs,
        rangeEndMs,
      ),
      ...containerFreshnessRegions(
        snapshot.containers,
        snapshot.generatedAt,
        rangeStartMs,
        rangeEndMs,
      ),
      ...maintenanceRegions(
        containerEvents,
        snapshot.containers,
        snapshot.generatedAt,
        rangeStartMs,
        rangeEndMs,
      ),
    ]),
  };
}
