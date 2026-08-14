import type { ActiveIncident, RecoveredIncident } from "./unified-incidents";
import { clipInterval, unionSeconds, type ReliabilityInterval } from "./reliability-metrics";
import type {
  ReliabilityMaintenanceWindow,
  ReliabilitySloMaintenanceAdjustment,
  ReliabilitySloServiceId,
} from "./reliability-types";

type Incident = ActiveIncident | RecoveredIncident;

const SLO_SERVICE_IDS: ReliabilitySloServiceId[] = [
  "overall",
  "host",
  "container",
  "backup",
];
const NON_EXCLUDABLE_CONTAINER_REASONS = new Set(["OOMKilledを検知"]);

function effectiveWindowInterval(
  window: ReliabilityMaintenanceWindow,
  rangeStart: number,
  rangeEnd: number,
): ReliabilityInterval | null {
  const effectiveEnd = window.cancelledAt
    ? Math.min(Date.parse(window.endsAt), Date.parse(window.cancelledAt))
    : Date.parse(window.endsAt);
  const start = Math.max(Date.parse(window.startsAt), rangeStart);
  const end = Math.min(effectiveEnd, rangeEnd);
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    ? { start, end }
    : null;
}

function maintenanceExcludable(incident: Incident): boolean {
  return !(
    incident.entityType === "container" &&
    NON_EXCLUDABLE_CONTAINER_REASONS.has(incident.startReason)
  );
}

function appliesToIncident(
  window: ReliabilityMaintenanceWindow,
  incident: Incident,
): boolean {
  if (!maintenanceExcludable(incident)) return false;

  switch (window.scopeType) {
    case "service":
      return window.serviceId === "overall" || window.serviceId === incident.entityType;
    case "host":
      return window.hostId === incident.hostId;
    case "container":
      return (
        incident.entityType === "container" &&
        window.hostId === incident.hostId &&
        window.containerName === incident.containerName
      );
    case "backup":
      return (
        incident.entityType === "backup" &&
        window.hostId === incident.hostId &&
        window.backupTarget === incident.backupTarget &&
        window.gameMode === incident.gameMode &&
        window.backupType === incident.backupType
      );
  }
}

function subtractIntervals(
  source: ReliabilityInterval,
  exclusions: ReliabilityInterval[],
): ReliabilityInterval[] {
  const clipped = exclusions
    .map((exclusion) => ({
      start: Math.max(source.start, exclusion.start),
      end: Math.min(source.end, exclusion.end),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  if (clipped.length === 0) return [source];

  const result: ReliabilityInterval[] = [];
  let cursor = source.start;

  for (const exclusion of clipped) {
    if (exclusion.end <= cursor) continue;
    if (exclusion.start > cursor) {
      result.push({ start: cursor, end: Math.min(exclusion.start, source.end) });
    }
    cursor = Math.max(cursor, exclusion.end);
    if (cursor >= source.end) break;
  }

  if (cursor < source.end) result.push({ start: cursor, end: source.end });
  return result.filter((interval) => interval.end > interval.start);
}

function incidentInterval(
  incident: Incident,
  rangeStart: number,
  rangeEnd: number,
): ReliabilityInterval | null {
  if ("recoveredAt" in incident) {
    return clipInterval(incident.startedAt, incident.recoveredAt, rangeStart, rangeEnd);
  }
  if (!incident.exactStart || !incident.startedAt) return null;
  return clipInterval(
    incident.startedAt,
    new Date(rangeEnd).toISOString(),
    rangeStart,
    rangeEnd,
  );
}

export function collectMaintenanceAdjustedDowntime(
  active: ActiveIncident[],
  recovered: RecoveredIncident[],
  windows: ReliabilityMaintenanceWindow[],
  rangeStart: number,
  rangeEnd: number,
): Omit<ReliabilitySloMaintenanceAdjustment, "serviceId"> {
  const rawIntervals: ReliabilityInterval[] = [];
  const countedIntervals: ReliabilityInterval[] = [];
  let exactCoverage = true;

  const windowIntervals = windows
    .map((window) => ({ window, interval: effectiveWindowInterval(window, rangeStart, rangeEnd) }))
    .filter(
      (entry): entry is { window: ReliabilityMaintenanceWindow; interval: ReliabilityInterval } =>
        entry.interval !== null,
    );

  for (const incident of recovered) {
    const interval = incidentInterval(incident, rangeStart, rangeEnd);
    if (!interval) continue;
    rawIntervals.push(interval);
    countedIntervals.push(
      ...subtractIntervals(
        interval,
        windowIntervals
          .filter(({ window }) => appliesToIncident(window, incident))
          .map(({ interval: exclusion }) => exclusion),
      ),
    );
  }

  for (const incident of active) {
    if (!incident.exactStart || !incident.startedAt) {
      exactCoverage = false;
      continue;
    }
    const interval = incidentInterval(incident, rangeStart, rangeEnd);
    if (!interval) continue;
    rawIntervals.push(interval);
    countedIntervals.push(
      ...subtractIntervals(
        interval,
        windowIntervals
          .filter(({ window }) => appliesToIncident(window, incident))
          .map(({ interval: exclusion }) => exclusion),
      ),
    );
  }

  const rawDowntimeSeconds = unionSeconds(rawIntervals);
  const countedDowntimeSeconds = unionSeconds(countedIntervals);

  return {
    rawDowntimeSeconds,
    countedDowntimeSeconds,
    excludedMaintenanceSeconds: Math.max(0, rawDowntimeSeconds - countedDowntimeSeconds),
    exactCoverage,
  };
}

export function buildReliabilityMaintenanceAdjustments(
  active: ActiveIncident[],
  recovered: RecoveredIncident[],
  windows: ReliabilityMaintenanceWindow[],
  rangeStart: number,
  rangeEnd: number,
): ReliabilitySloMaintenanceAdjustment[] {
  return SLO_SERVICE_IDS.map((serviceId) => {
    const scopedActive =
      serviceId === "overall"
        ? active
        : active.filter((incident) => incident.entityType === serviceId);
    const scopedRecovered =
      serviceId === "overall"
        ? recovered
        : recovered.filter((incident) => incident.entityType === serviceId);

    return {
      serviceId,
      ...collectMaintenanceAdjustedDowntime(
        scopedActive,
        scopedRecovered,
        windows,
        rangeStart,
        rangeEnd,
      ),
    };
  });
}
