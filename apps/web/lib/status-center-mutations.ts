import "server-only";

export type StatusCenterMutationActor = {
  actorEmail: string | null;
  actorRole: "administrator" | "owner";
  actorDiscordUserId: string | null;
};

export type StatusIncidentMutationActor = StatusCenterMutationActor;

export type CreateStatusIncidentInput = StatusIncidentMutationActor & {
  title: string;
  impact: "none" | "minor" | "major" | "critical";
  affectedServiceIds: string[];
  startedAt: string;
  summary: string;
  idempotencyKey: string;
};

export type PublishStatusIncidentInput = StatusIncidentMutationActor & {
  publicId: string;
  requestId: string;
};

export type UpdateStatusIncidentInput = StatusIncidentMutationActor & {
  publicId: string;
  lifecycleStatus: "investigating" | "identified" | "monitoring" | "resolved";
  message: string;
  requestId: string;
};

export type CreateStatusMaintenanceInput = StatusCenterMutationActor & {
  title: string;
  body: string;
  affectedServiceIds: string[];
  startsAt: string;
  endsAt: string;
  reliabilityWindowId: string | null;
  idempotencyKey: string;
};

export type StatusMaintenanceActionInput = StatusCenterMutationActor & {
  publicId: string;
  requestId: string;
};

type IncidentMutationResult = {
  publicId: string;
  lifecycleStatus: string;
  publicationState: string;
};

type MaintenanceMutationResult = {
  publicId: string;
  publicationState: "draft" | "published" | "cancelled";
};

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

async function callRpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const { url, serviceRoleKey } = configuration();
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 512);
    throw new Error(`Status Center ${name} RPCが${response.status}を返しました: ${detail}`);
  }
  return (await response.json()) as unknown;
}

function singleRow(value: unknown, label: string): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`${label}応答件数が不正です`);
  }
  const row = value[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`${label}応答形式が不正です`);
  }
  return row as Record<string, unknown>;
}

function parseIncidentResult(value: unknown): IncidentMutationResult {
  const record = singleRow(value, "Status Incident Mutation");
  if (
    typeof record.public_id !== "string" ||
    !/^INC-[A-F0-9]{12}$/.test(record.public_id) ||
    typeof record.lifecycle_status !== "string" ||
    typeof record.publication_state !== "string"
  ) {
    throw new Error("Status Incident Mutation応答値が不正です");
  }
  return {
    publicId: record.public_id,
    lifecycleStatus: record.lifecycle_status,
    publicationState: record.publication_state,
  };
}

function parseMaintenanceResult(value: unknown): MaintenanceMutationResult {
  const record = singleRow(value, "Status Maintenance Mutation");
  if (
    typeof record.public_id !== "string" ||
    !/^MNT-[A-F0-9]{12}$/.test(record.public_id) ||
    typeof record.publication_state !== "string" ||
    !["draft", "published", "cancelled"].includes(record.publication_state)
  ) {
    throw new Error("Status Maintenance Mutation応答値が不正です");
  }
  return {
    publicId: record.public_id,
    publicationState: record.publication_state as MaintenanceMutationResult["publicationState"],
  };
}

function actorParams(actor: StatusCenterMutationActor): Record<string, unknown> {
  return {
    p_actor_email: actor.actorEmail,
    p_actor_role: actor.actorRole,
    p_actor_discord_user_id: actor.actorDiscordUserId,
  };
}

export async function createStatusIncident(
  input: CreateStatusIncidentInput,
): Promise<IncidentMutationResult> {
  return parseIncidentResult(await callRpc("create_status_incident_v1", {
    p_title: input.title,
    p_impact: input.impact,
    p_affected_service_ids: input.affectedServiceIds,
    p_started_at: input.startedAt,
    p_summary: input.summary,
    p_idempotency_key: input.idempotencyKey,
    ...actorParams(input),
  }));
}

export async function publishStatusIncident(
  input: PublishStatusIncidentInput,
): Promise<IncidentMutationResult> {
  return parseIncidentResult(await callRpc("publish_status_incident_v1", {
    p_public_id: input.publicId,
    p_request_id: input.requestId,
    ...actorParams(input),
  }));
}

export async function updateStatusIncident(
  input: UpdateStatusIncidentInput,
): Promise<IncidentMutationResult> {
  return parseIncidentResult(await callRpc("append_status_incident_update_v1", {
    p_public_id: input.publicId,
    p_lifecycle_status: input.lifecycleStatus,
    p_message: input.message,
    p_request_id: input.requestId,
    ...actorParams(input),
  }));
}

export async function createStatusMaintenance(
  input: CreateStatusMaintenanceInput,
): Promise<MaintenanceMutationResult> {
  return parseMaintenanceResult(await callRpc("create_status_maintenance_v1", {
    p_title: input.title,
    p_body: input.body,
    p_affected_service_ids: input.affectedServiceIds,
    p_starts_at: input.startsAt,
    p_ends_at: input.endsAt,
    p_reliability_window_id: input.reliabilityWindowId,
    p_idempotency_key: input.idempotencyKey,
    ...actorParams(input),
  }));
}

export async function publishStatusMaintenance(
  input: StatusMaintenanceActionInput,
): Promise<MaintenanceMutationResult> {
  return parseMaintenanceResult(await callRpc("publish_status_maintenance_v1", {
    p_public_id: input.publicId,
    p_request_id: input.requestId,
    ...actorParams(input),
  }));
}

export async function cancelStatusMaintenance(
  input: StatusMaintenanceActionInput,
): Promise<MaintenanceMutationResult> {
  return parseMaintenanceResult(await callRpc("cancel_status_maintenance_v1", {
    p_public_id: input.publicId,
    p_request_id: input.requestId,
    ...actorParams(input),
  }));
}
