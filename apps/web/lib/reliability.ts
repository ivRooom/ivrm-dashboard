import "server-only";

import { getUnifiedIncidentCenterSnapshot } from "./unified-incidents";
import { getNotificationCenterSnapshot } from "./notifications";
import { buildIncidentService } from "./reliability-incident-service";
import { buildNotificationService } from "./reliability-notification-service";
import type { ReliabilityRange, ReliabilitySnapshot } from "./reliability-types";

export type {
  ReliabilityHealth,
  ReliabilityRange,
  ReliabilityService,
  ReliabilityServiceId,
  ReliabilitySnapshot,
} from "./reliability-types";

export async function getReliabilitySnapshot(range: ReliabilityRange): Promise<ReliabilitySnapshot> {
  const incidents = await getUnifiedIncidentCenterSnapshot(range);
  const notification = await getNotificationCenterSnapshot().catch(() => null);
  const set = (type: "host" | "container" | "backup") => ({
    active: incidents.active.filter((item) => item.entityType === type),
    recovered: incidents.recovered.filter((item) => item.entityType === type),
  });
  const services = [
    buildIncidentService("host", set("host"), range, incidents.generatedAt),
    buildIncidentService("container", set("container"), range, incidents.generatedAt),
    buildIncidentService("backup", set("backup"), range, incidents.generatedAt, incidents.backupDataAvailable),
    buildNotificationService(notification),
  ];
  throw new Error(JSON.stringify({ incidents, notification, services }));
}
