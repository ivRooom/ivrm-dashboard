import "server-only";

export type StatusIncidentLifecycle =
  | "investigating"
  | "identified"
  | "monitoring"
  | "resolved";
export type StatusIncidentImpact = "none" | "minor" | "major" | "critical";
export type StatusPublicationState = "draft" | "published" | "archived";
export type StatusMaintenancePublicationState = "draft" | "published" | "cancelled";
export type StatusAnnouncementKind = "info" | "warning";

export type StatusCenterIncident = {
  publicId: string;
  title: string;
  lifecycleStatus: StatusIncidentLifecycle;
  impact: StatusIncidentImpact;
  affectedServiceIds: string[];
  sourceType: "automatic" | "manual";
  startedAt: string;
  resolvedAt: string | null;
  summary: string;
  publicationState: StatusPublicationState;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StatusCenterMaintenance = {
  publicId: string;
  title: string;
  body: string;
  affectedServiceIds: string[];
  startsAt: string;
  endsAt: string;
  publicationState: StatusMaintenancePublicationState;
  publishedAt: string | null;
  cancelledAt: string | null;
  reliabilityWindowId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StatusCenterAnnouncement = {
  publicId: string;
  kind: StatusAnnouncementKind;
  title: string;
  body: string;
  affectedServiceIds: string[];
  publishAt: string;
  expiresAt: string | null;
  publicationState: StatusPublicationState;
  publishedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StatusCenterOverview = {
  generatedAt: string;
  incidents: StatusCenterIncident[];
  maintenance: StatusCenterMaintenance[];
  announcements: StatusCenterAnnouncement[];
};

const PUBLIC_ID_PATTERN = /^(INC|MNT|ANN)-[A-F0-9]{12}$/;
const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}が設定されていません`);
  return value;
}

function configuration(): { url: string; serviceRoleKey: string } {
  return {
    url: requireEnvironment("SUPABASE_URL").replace(/\/$/, ""),
    serviceRoleKey: requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

function headers(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function callRpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const { url, serviceRoleKey } = configuration();
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: headers(serviceRoleKey),
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Status Center ${name} RPCが${response.status}を返しました`);
  }
  return (await response.json()) as unknown;
}

function objectRow(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}形式が不正です`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, max = 4_000): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new Error(`${label}が不正です`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}日時が不正です`);
  }
  return value;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null;
  return timestamp(value, label);
}

function publicId(value: unknown, prefix: "INC" | "MNT" | "ANN"): string {
  const text = stringValue(value, `${prefix} publicId`, 32);
  if (!PUBLIC_ID_PATTERN.test(text) || !text.startsWith(`${prefix}-`)) {
    throw new Error(`${prefix} publicIdが不正です`);
  }
  return text;
}

function serviceIds(value: unknown, optional = false): string[] {
  if (optional && value === null) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error("Status Center affectedServiceIdsが不正です");
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || !SERVICE_ID_PATTERN.test(item)) {
      throw new Error("Status Center serviceIdが不正です");
    }
    return item;
  });
  if (new Set(result).size !== result.length) {
    throw new Error("Status Center serviceIdが重複しています");
  }
  return result;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label}が不正です`);
  }
  return value as T;
}

function parseIncident(value: unknown): StatusCenterIncident {
  const row = objectRow(value, "Status Center Incident");
  return {
    publicId: publicId(row.public_id, "INC"),
    title: stringValue(row.title, "Incident title", 160),
    lifecycleStatus: enumValue(
      row.lifecycle_status,
      ["investigating", "identified", "monitoring", "resolved"] as const,
      "Incident lifecycleStatus",
    ),
    impact: enumValue(
      row.impact,
      ["none", "minor", "major", "critical"] as const,
      "Incident impact",
    ),
    affectedServiceIds: serviceIds(row.affected_service_ids),
    sourceType: enumValue(row.source_type, ["automatic", "manual"] as const, "Incident sourceType"),
    startedAt: timestamp(row.started_at, "Incident startedAt"),
    resolvedAt: nullableTimestamp(row.resolved_at, "Incident resolvedAt"),
    summary: stringValue(row.summary, "Incident summary", 2_000),
    publicationState: enumValue(
      row.publication_state,
      ["draft", "published", "archived"] as const,
      "Incident publicationState",
    ),
    publishedAt: nullableTimestamp(row.published_at, "Incident publishedAt"),
    createdAt: timestamp(row.created_at, "Incident createdAt"),
    updatedAt: timestamp(row.updated_at, "Incident updatedAt"),
  };
}

function parseMaintenance(value: unknown): StatusCenterMaintenance {
  const row = objectRow(value, "Status Center Maintenance");
  const reliabilityWindowId = row.reliability_window_id;
  if (
    reliabilityWindowId !== null &&
    (typeof reliabilityWindowId !== "string" || !UUID_PATTERN.test(reliabilityWindowId))
  ) {
    throw new Error("Maintenance reliabilityWindowIdが不正です");
  }
  return {
    publicId: publicId(row.public_id, "MNT"),
    title: stringValue(row.title, "Maintenance title", 160),
    body: stringValue(row.body, "Maintenance body", 4_000),
    affectedServiceIds: serviceIds(row.affected_service_ids),
    startsAt: timestamp(row.starts_at, "Maintenance startsAt"),
    endsAt: timestamp(row.ends_at, "Maintenance endsAt"),
    publicationState: enumValue(
      row.publication_state,
      ["draft", "published", "cancelled"] as const,
      "Maintenance publicationState",
    ),
    publishedAt: nullableTimestamp(row.published_at, "Maintenance publishedAt"),
    cancelledAt: nullableTimestamp(row.cancelled_at, "Maintenance cancelledAt"),
    reliabilityWindowId: reliabilityWindowId as string | null,
    createdAt: timestamp(row.created_at, "Maintenance createdAt"),
    updatedAt: timestamp(row.updated_at, "Maintenance updatedAt"),
  };
}

function parseAnnouncement(value: unknown): StatusCenterAnnouncement {
  const row = objectRow(value, "Status Center Announcement");
  return {
    publicId: publicId(row.public_id, "ANN"),
    kind: enumValue(row.kind, ["info", "warning"] as const, "Announcement kind"),
    title: stringValue(row.title, "Announcement title", 160),
    body: stringValue(row.body, "Announcement body", 4_000),
    affectedServiceIds: serviceIds(row.affected_service_ids, true),
    publishAt: timestamp(row.publish_at, "Announcement publishAt"),
    expiresAt: nullableTimestamp(row.expires_at, "Announcement expiresAt"),
    publicationState: enumValue(
      row.publication_state,
      ["draft", "published", "archived"] as const,
      "Announcement publicationState",
    ),
    publishedAt: nullableTimestamp(row.published_at, "Announcement publishedAt"),
    archivedAt: nullableTimestamp(row.archived_at, "Announcement archivedAt"),
    createdAt: timestamp(row.created_at, "Announcement createdAt"),
    updatedAt: timestamp(row.updated_at, "Announcement updatedAt"),
  };
}

export async function getStatusCenterOverview(limit = 100): Promise<StatusCenterOverview> {
  const payload = objectRow(
    await callRpc("get_status_center_overview_v1", {
      p_limit: Math.min(Math.max(Math.trunc(limit), 1), 250),
    }),
    "Status Center Overview",
  );
  const generatedAt = timestamp(payload.generatedAt, "Status Center generatedAt");
  if (!Array.isArray(payload.incidents) || !Array.isArray(payload.maintenance) || !Array.isArray(payload.announcements)) {
    throw new Error("Status Center Overview一覧形式が不正です");
  }
  return {
    generatedAt,
    incidents: payload.incidents.map(parseIncident),
    maintenance: payload.maintenance.map(parseMaintenance),
    announcements: payload.announcements.map(parseAnnouncement),
  };
}
