import type { ActiveIncident, RecoveredIncident } from "./unified-incidents";

export type ReliabilityInterval = { start: number; end: number };

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const left = sorted[middle - 1];
  const right = sorted[middle];
  return left === undefined || right === undefined ? null : Math.floor((left + right) / 2);
}

export function incidentEntityKey(incident: ActiveIncident | RecoveredIncident): string {
  if (incident.entityType === "backup") {
    return `${incident.hostId}:${incident.backupTarget}:${incident.gameMode}:${incident.backupType}`;
  }
  return incident.containerName ? `${incident.hostId}:${incident.containerName}` : `host:${incident.hostId}`;
}

export function clipInterval(
  startedAt: string,
  endedAt: string,
  rangeStart: number,
  rangeEnd: number,
): ReliabilityInterval | null {
  const start = Math.max(Date.parse(startedAt), rangeStart);
  const end = Math.min(Date.parse(endedAt), rangeEnd);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

export function unionSeconds(intervals: ReliabilityInterval[]): number {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const first = sorted[0];
  if (!first) return 0;
  let current = first;
  let milliseconds = 0;

  for (const interval of sorted.slice(1)) {
    if (interval.start <= current.end) {
      current = { start: current.start, end: Math.max(current.end, interval.end) };
      continue;
    }
    milliseconds += current.end - current.start;
    current = interval;
  }

  return Math.floor((milliseconds + current.end - current.start) / 1000);
}

export function collectKnownDowntime(
  active: ActiveIncident[],
  recovered: RecoveredIncident[],
  rangeStart: number,
  rangeEnd: number,
): { seconds: number; exactCoverage: boolean } {
  const intervals: ReliabilityInterval[] = [];
  let exactCoverage = true;

  for (const incident of recovered) {
    const interval = clipInterval(incident.startedAt, incident.recoveredAt, rangeStart, rangeEnd);
    if (interval) intervals.push(interval);
  }

  for (const incident of active) {
    if (!incident.exactStart || !incident.startedAt) {
      exactCoverage = false;
      continue;
    }
    const interval = clipInterval(
      incident.startedAt,
      new Date(rangeEnd).toISOString(),
      rangeStart,
      rangeEnd,
    );
    if (interval) intervals.push(interval);
  }

  return { seconds: unionSeconds(intervals), exactCoverage };
}
