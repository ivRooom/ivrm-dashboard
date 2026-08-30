import "server-only";

export type PublicStatusIncidentUpdate = {
  status: "investigating" | "identified" | "monitoring" | "resolved";
  message: string;
  publishedAt: string;
};

export type PublicStatusIncident = {
  publicId: string;
  title: string;
  status: "investigating" | "identified" | "monitoring" | "resolved";
  impact: "none" | "minor" | "major" | "critical";
  affectedServiceIds: string[];
  startedAt: string;
  resolvedAt: string | null;
  updatedAt: string;
  summary: string;
  source: "automatic" | "manual";
  updates: PublicStatusIncidentUpdate[];
};

export type PublicStatusMaintenance = {
  publicId: string;
  title: string;
  summary: string;
  affectedServiceIds: string[];
  startsAt: string;
  endsAt: string;
  state: "scheduled" | "in_progress" | "completed" | "cancelled";
  updatedAt: string;
};

export type PublicStatusAnnouncement = {
  publicId: string;
  kind: "info" | "warning";
  title: string;
  body: string;
  affectedServiceIds: string[];
  publishedAt: string;
  expiresAt: string | null;
  active: boolean;
};

export type PublicStatusFeed = {
  schemaVersion: "1.0";
  generatedAt: string;
  incidents: PublicStatusIncident[];
  maintenance: PublicStatusMaintenance[];
  announcements: PublicStatusAnnouncement[];
};

const PUBLIC_ID = /^(INC|MNT|ANN)-[A-F0-9]{12}$/;
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}が設定されていません`);
  return value;
}

function row(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label}形式が不正です`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new Error(`${label}が不正です`);
  return value;
}

function instant(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label}日時が不正です`);
  return result;
}

function optionalInstant(value: unknown, label: string): string | null {
  return value === null ? null : instant(value, label);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${label}が不正です`);
  return value as T;
}

function publicId(value: unknown, prefix: "INC" | "MNT" | "ANN"): string {
  const result = text(value, `${prefix} publicId`, 32);
  if (!PUBLIC_ID.test(result) || !result.startsWith(`${prefix}-`)) throw new Error(`${prefix} publicIdが不正です`);
  return result;
}

function services(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("affectedServiceIds形式が不正です");
  const result = value.map((item) => {
    if (typeof item !== "string" || !SERVICE_ID.test(item)) throw new Error("serviceIdが不正です");
    return item;
  });
  if (new Set(result).size !== result.length) throw new Error("serviceIdが重複しています");
  return result;
}

function parseIncident(value: unknown): PublicStatusIncident {
  const item = row(value, "Incident");
  const updates = item.updates;
  if (!Array.isArray(updates) || updates.length > 500) throw new Error("Incident updates形式が不正です");
  return {
    publicId: publicId(item.publicId, "INC"),
    title: text(item.title, "Incident title", 160),
    status: enumValue(item.status, ["investigating", "identified", "monitoring", "resolved"] as const, "Incident status"),
    impact: enumValue(item.impact, ["none", "minor", "major", "critical"] as const, "Incident impact"),
    affectedServiceIds: services(item.affectedServiceIds),
    startedAt: instant(item.startedAt, "Incident startedAt"),
    resolvedAt: optionalInstant(item.resolvedAt, "Incident resolvedAt"),
    updatedAt: instant(item.updatedAt, "Incident updatedAt"),
    summary: text(item.summary, "Incident summary", 2_000),
    source: enumValue(item.source, ["automatic", "manual"] as const, "Incident source"),
    updates: updates.map((update) => {
      const detail = row(update, "Incident update");
      return {
        status: enumValue(detail.status, ["investigating", "identified", "monitoring", "resolved"] as const, "Incident update status"),
        message: text(detail.message, "Incident update message", 2_000),
        publishedAt: instant(detail.publishedAt, "Incident update publishedAt"),
      };
    }),
  };
}

function parseMaintenance(value: unknown): PublicStatusMaintenance {
  const item = row(value, "Maintenance");
  return {
    publicId: publicId(item.publicId, "MNT"),
    title: text(item.title, "Maintenance title", 160),
    summary: text(item.summary, "Maintenance summary", 4_000),
    affectedServiceIds: services(item.affectedServiceIds),
    startsAt: instant(item.startsAt, "Maintenance startsAt"),
    endsAt: instant(item.endsAt, "Maintenance endsAt"),
    state: enumValue(item.state, ["scheduled", "in_progress", "completed", "cancelled"] as const, "Maintenance state"),
    updatedAt: instant(item.updatedAt, "Maintenance updatedAt"),
  };
}

function parseAnnouncement(value: unknown): PublicStatusAnnouncement {
  const item = row(value, "Announcement");
  if (typeof item.active !== "boolean") throw new Error("Announcement activeが不正です");
  return {
    publicId: publicId(item.publicId, "ANN"),
    kind: enumValue(item.kind, ["info", "warning"] as const, "Announcement kind"),
    title: text(item.title, "Announcement title", 160),
    body: text(item.body, "Announcement body", 4_000),
    affectedServiceIds: services(item.affectedServiceIds),
    publishedAt: instant(item.publishedAt, "Announcement publishedAt"),
    expiresAt: optionalInstant(item.expiresAt, "Announcement expiresAt"),
    active: item.active,
  };
}

export async function getPublicStatusFeed(): Promise<PublicStatusFeed> {
  const url = requireEnvironment("SUPABASE_URL").replace(/\/$/, "");
  const serviceRoleKey = requireEnvironment("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${url}/rest/v1/rpc/get_status_public_feed_v1`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_since: new Date(Date.now() - 10 * 365 * 86_400_000).toISOString(), p_limit: 500 }),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Public Status Feed RPCが${response.status}を返しました`);
  const payload = row(await response.json(), "Public Status Feed");
  if (payload.schemaVersion !== "1.0" || !Array.isArray(payload.incidents) || !Array.isArray(payload.maintenance) || !Array.isArray(payload.announcements)) {
    throw new Error("Public Status Feed契約が不正です");
  }
  return {
    schemaVersion: "1.0",
    generatedAt: instant(payload.generatedAt, "Public Status Feed generatedAt"),
    incidents: payload.incidents.map(parseIncident),
    maintenance: payload.maintenance.map(parseMaintenance),
    announcements: payload.announcements.map(parseAnnouncement),
  };
}
