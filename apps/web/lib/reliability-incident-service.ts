import type {
  ActiveIncident,
  IncidentEntityType,
  IncidentRange,
  RecoveredIncident,
} from "./unified-incidents";
import { INCIDENT_RANGE_CONFIG } from "./unified-incidents";
import {
  collectKnownDowntime,
  incidentEntityKey,
  median,
} from "./reliability-metrics";
import type { ReliabilityHealth, ReliabilityService } from "./reliability-types";

export type IncidentSet = {
  active: ActiveIncident[];
  recovered: RecoveredIncident[];
};

const COPY = {
  host: ["Host Platform", "Agent Heartbeatとホスト到達性の継続性"],
  container: ["Container Runtime", "期待状態・Health・OOM・Restartを含むDocker稼働品質"],
  backup: ["Backup Protection", "Run・SHA-256・Age・Remote Sync・Retention・Restore Test"],
} as const;

function health(active: ActiveIncident[], available: boolean): ReliabilityHealth {
  if (!available) return "unknown";
  if (active.some((incident) => incident.severity === "critical")) return "critical";
  if (active.length > 0) return "degraded";
  return "operational";
}

export function buildIncidentService(
  type: IncidentEntityType,
  incidents: IncidentSet,
  range: IncidentRange,
  generatedAt: string,
  available = true,
): ReliabilityService {
  const copy = COPY[type as keyof typeof COPY];
  const rangeEnd = Date.parse(generatedAt);
  const rangeStart = rangeEnd - INCIDENT_RANGE_CONFIG[range].hours * 3_600_000;
  const downtime = collectKnownDowntime(incidents.active, incidents.recovered, rangeStart, rangeEnd);
  const knownDowntimeSeconds = available ? downtime.seconds : null;
  const rangeSeconds = INCIDENT_RANGE_CONFIG[range].hours * 3_600;
  const durations = incidents.recovered.map((incident) => incident.durationSeconds);
  const affected = new Set<string>();
  incidents.active.forEach((incident) => affected.add(incidentEntityKey(incident)));
  incidents.recovered.forEach((incident) => affected.add(incidentEntityKey(incident)));

  return {
    id: type,
    label: copy?.[0] ?? type,
    description: copy?.[1] ?? "",
    health: health(incidents.active, available),
    activeIncidentCount: incidents.active.length,
    activeCriticalCount: incidents.active.filter((incident) => incident.severity === "critical").length,
    activeWarningCount: incidents.active.filter((incident) => incident.severity === "warning").length,
    recoveredIncidentCount: incidents.recovered.length,
    knownDowntimeSeconds,
    incidentFreeRatio: knownDowntimeSeconds === null ? null : Math.max(0, Math.min(1, 1 - knownDowntimeSeconds / rangeSeconds)),
    exactCoverage: available && downtime.exactCoverage,
    medianRecoverySeconds: median(durations),
    longestRecoverySeconds: durations.length > 0 ? Math.max(...durations) : null,
    latestRecoveredAt: incidents.recovered.map((incident) => incident.recoveredAt).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
    affectedEntityCount: affected.size,
    detailHref: type === "host" ? "/hosts" : type === "container" ? "/containers" : `/backups?range=${range}`,
  };
}
