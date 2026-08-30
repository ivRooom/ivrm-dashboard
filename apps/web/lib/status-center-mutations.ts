import "server-only";

export type StatusIncidentMutationActor = {
  actorEmail: string | null;
  actorRole: "administrator" | "owner";
  actorDiscordUserId: string | null;
};

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

type MutationResult = {
  publicId: string;
  lifecycleStatus: string;
  publicationState: string;
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

function parseResult(value: unknown): MutationResult {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Status Incident Mutation応答件数が不正です");
  }
  const row = value[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("Status Incident Mutation応答形式が不正です");
  }
  const record = row as Record<string, unknown>;
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

function actorParams(actor: StatusIncidentMutationActor): Record<string, unknown> {
  return {
    p_actor_email: actor.actorEmail,
    p_actor_role: actor.actorRole,
    p_actor_discord_user_id: actor.actorDiscordUserId,
  };
}

export async function createStatusIncident(
  input: CreateStatusIncidentInput,
): Promise<MutationResult> {
  return parseResult(await callRpc("create_status_incident_v1", {
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
): Promise<MutationResult> {
  return parseResult(await callRpc("publish_status_incident_v1", {
    p_public_id: input.publicId,
    p_request_id: input.requestId,
    ...actorParams(input),
  }));
}

export async function updateStatusIncident(
  input: UpdateStatusIncidentInput,
): Promise<MutationResult> {
  return parseResult(await callRpc("append_status_incident_update_v1", {
    p_public_id: input.publicId,
    p_lifecycle_status: input.lifecycleStatus,
    p_message: input.message,
    p_request_id: input.requestId,
    ...actorParams(input),
  }));
}
