import { INCIDENT_RANGE_CONFIG } from "./unified-incidents";
import type { UnifiedIncidentCenterSnapshot } from "./unified-incidents";
import { collectKnownDowntime, median } from "./reliability-metrics";
import { overallHealth } from "./reliability-notification-service";
import type { ReliabilityRange, ReliabilityService, ReliabilitySnapshot } from "./reliability-types";

export function buildOverall(
  data: UnifiedIncidentCenterSnapshot,
  services: ReliabilityService[],
  range: ReliabilityRange,
): ReliabilitySnapshot["overall"] {
  const end = Date.parse(data.generatedAt);
  const start = end - INCIDENT_RANGE_CONFIG[range].hours * 3_600_000;
  const downtime = collectKnownDowntime(data.active, data.recovered, start, end);
  const rangeSeconds = INCIDENT_RANGE_CONFIG[range].hours * 3_600;
  const durations = data.recovered.map((item) => item.durationSeconds);
  return {
    health: overallHealth(services),
    activeIncidentCount: data.active.length,
    activeCriticalCount: data.active.filter((item) => item.severity === "critical").length,
    knownDowntimeSeconds: downtime.seconds,
    incidentFreeRatio: Math.max(0, Math.min(1, 1 - downtime.seconds / rangeSeconds)),
    exactCoverage: downtime.exactCoverage && data.backupDataAvailable,
    recoveredIncidentCount: data.recovered.length,
    medianRecoverySeconds: median(durations),
    longestRecoverySeconds: durations.length ? Math.max(...durations) : null,
    affectedEntityCount: data.summary.affectedEntityCount,
  };
}
