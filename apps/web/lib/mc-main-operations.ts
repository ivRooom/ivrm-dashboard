import "server-only";

export const MC_MAIN_OPERATION_SERVER_ID = "oci-minecraft-01" as const;
export const MC_MAIN_OPERATION_TARGET = "mc-main" as const;
export const MC_MAIN_OPERATION_ACTIONS = [
  "start_backend",
  "restart_backend",
  "stop_backend",
] as const;

export type McMainOperationAction = (typeof MC_MAIN_OPERATION_ACTIONS)[number];
export type OperationJobStatus =
  | "queued"
  | "leased"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export type OperationJobView = {
  id: string;
  action: McMainOperationAction;
  status: OperationJobStatus;
  confirmationVerified: boolean;
  phase: string | null;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type EnqueueOperationResult = {
  jobId: string | null;
  jobStatus: OperationJobStatus | null;
  outcome: "created" | "existing" | "conflict" | "denied";
  errorCode: string | null;
};

export type ClaimedOperationJob = {
  jobId: string;
  action: McMainOperationAction;
  status: "leased" | "running";
  leaseExpiresAt: string;
};

export type OperationTransition = {
  serverId: typeof MC_MAIN_OPERATION_SERVER_ID;
  jobId: string;
  action: McMainOperationAction;
  expectedStatus: "leased" | "running";
  newStatus: "running" | "succeeded" | "failed";
  leaseOwner: string;
  requestId: string;
  details: Record<string, string>;
};

const JOB_STATUSES = new Set<OperationJobStatus>([
  "queued",
  "leased",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);
const ACTIONS = new Set<string>(MC_MAIN_OPERATION_ACTIONS);
const SAFE_PHASES = new Set([
  "claimed",
  "executing",
  "health_gate_passed",
  "stopped",
  "execution_failed",
]);

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}が設定されていません`);
  return value;
}

function configuration(): { url: string; serviceRoleKey: string } {
  const rawUrl = requireEnvironment("SUPABASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("SUPABASE_URLがURLではありません");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error("SUPABASE_URLは認証情報を含まないHTTPS URLで指定してください");
  }
  return {
    url: parsed.toString().replace(/\/$/, ""),
    serviceRoleKey: requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

function supabaseHeaders(serviceRoleKey: string): HeadersInit {
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
    headers: supabaseHeaders(serviceRoleKey),
    body: JSON.stringify(body),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Operation RPC ${name} failed with status ${response.status}`);
  }
  const text = await response.text();
  return text ? (JSON.parse(text) as unknown) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is McMainOperationAction {
  return typeof value === "string" && ACTIONS.has(value);
}

function isStatus(value: unknown): value is OperationJobStatus {
  return typeof value === "string" && JOB_STATUSES.has(value as OperationJobStatus);
}

function firstRow(value: unknown, label: string): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw new Error(`${label}の応答形式が不正です`);
  }
  return value[0];
}

export async function enqueueDiscordOperationJob(input: {
  discordSessionId: string;
  action: McMainOperationAction;
  idempotencyKeyHash: string;
  confirmation: string | null;
  requestId: string;
}): Promise<EnqueueOperationResult> {
  const row = firstRow(
    await callRpc("enqueue_discord_operation_job", {
      p_discord_session_id: input.discordSessionId,
      p_server_id: MC_MAIN_OPERATION_SERVER_ID,
      p_operation_type: input.action,
      p_payload: {},
      p_idempotency_key_hash: input.idempotencyKeyHash,
      p_confirmation_text: input.confirmation,
      p_request_id: input.requestId,
    }),
    "Operation enqueue",
  );

  if (
    !["created", "existing", "conflict", "denied"].includes(String(row.outcome)) ||
    (row.job_id !== null && typeof row.job_id !== "string") ||
    (row.job_status !== null && !isStatus(row.job_status)) ||
    (row.error_code !== null && typeof row.error_code !== "string")
  ) {
    throw new Error("Operation enqueueの応答値が不正です");
  }

  return {
    jobId: row.job_id as string | null,
    jobStatus: row.job_status as OperationJobStatus | null,
    outcome: row.outcome as EnqueueOperationResult["outcome"],
    errorCode: row.error_code as string | null,
  };
}

export async function listDiscordOperationJobs(discordUserId: string): Promise<OperationJobView[]> {
  if (!/^[0-9]{17,20}$/.test(discordUserId)) return [];
  const { url, serviceRoleKey } = configuration();

  const hostResponse = await fetch(
    `${url}/rest/v1/hosts?select=id&server_id=eq.${MC_MAIN_OPERATION_SERVER_ID}&enabled=eq.true&limit=1`,
    {
      headers: supabaseHeaders(serviceRoleKey),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!hostResponse.ok) throw new Error("Operation host lookup failed");
  const hosts = (await hostResponse.json()) as unknown;
  if (!Array.isArray(hosts) || hosts.length !== 1 || !isRecord(hosts[0]) || typeof hosts[0].id !== "string") {
    return [];
  }

  const query = new URLSearchParams({
    select: "id,operation_type,status,confirmation_verified,error_code,result_summary,created_at,started_at,finished_at",
    host_id: `eq.${hosts[0].id}`,
    requested_actor_type: "eq.discord",
    requested_discord_user_id: `eq.${discordUserId}`,
    operation_type: "in.(start_backend,restart_backend,stop_backend)",
    order: "created_at.desc",
    limit: "20",
  });
  const response = await fetch(`${url}/rest/v1/operation_jobs?${query.toString()}`, {
    headers: supabaseHeaders(serviceRoleKey),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Operation jobs lookup failed");
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) throw new Error("Operation jobsの応答形式が不正です");

  const jobs: OperationJobView[] = [];
  for (const value of body) {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      !isAction(value.operation_type) ||
      !isStatus(value.status) ||
      typeof value.confirmation_verified !== "boolean" ||
      (value.error_code !== null && typeof value.error_code !== "string") ||
      typeof value.created_at !== "string" ||
      (value.started_at !== null && typeof value.started_at !== "string") ||
      (value.finished_at !== null && typeof value.finished_at !== "string")
    ) {
      throw new Error("Operation jobデータが不正です");
    }
    const summary = isRecord(value.result_summary) ? value.result_summary : null;
    const phase = summary && typeof summary.phase === "string" && SAFE_PHASES.has(summary.phase)
      ? summary.phase
      : null;
    jobs.push({
      id: value.id,
      action: value.operation_type,
      status: value.status,
      confirmationVerified: value.confirmation_verified,
      phase,
      errorCode: value.error_code as string | null,
      createdAt: value.created_at,
      startedAt: value.started_at as string | null,
      finishedAt: value.finished_at as string | null,
    });
  }
  return jobs;
}

export async function recordOperationRequestDenied(input: {
  requestId: string;
  discordUserId: string;
  role: string;
  reason: string;
  action?: McMainOperationAction;
}): Promise<void> {
  if (!/^[a-z0-9._:-]{1,120}$/.test(input.reason)) return;
  await callRpc("append_audit_log", {
    p_request_id: input.requestId,
    p_actor_user_id: null,
    p_actor_email: null,
    p_actor_role: input.role,
    p_actor_ip: null,
    p_action: "OPERATION_REQUEST_DENIED",
    p_target_type: "operation_job",
    p_target_id: null,
    p_result: "denied",
    p_metadata: {
      actorType: "discord",
      discordUserId: input.discordUserId,
      reason: input.reason,
      ...(input.action ? { operationType: input.action } : {}),
    },
  }).catch(() => undefined);
}

export async function acceptOperationAgentRequest(input: {
  serverId: string;
  kind: "claim" | "transition";
  nonce: string;
  bodySha256: string;
}): Promise<boolean> {
  const result = await callRpc("accept_operation_agent_request", {
    p_server_id: input.serverId,
    p_request_kind: input.kind,
    p_nonce: input.nonce,
    p_body_sha256: input.bodySha256,
  });
  if (typeof result !== "boolean") throw new Error("Agent replay ledgerの応答が不正です");
  return result;
}

export async function claimMcMainOperationJob(input: {
  serverId: string;
  leaseOwner: string;
  requestId: string;
}): Promise<ClaimedOperationJob | null> {
  const result = await callRpc("claim_mc_main_operation_job", {
    p_server_id: input.serverId,
    p_lease_owner: input.leaseOwner,
    p_request_id: input.requestId,
    p_lease_seconds: 300,
  });
  if (!Array.isArray(result)) throw new Error("Operation claimの応答形式が不正です");
  if (result.length === 0) return null;
  if (result.length !== 1 || !isRecord(result[0])) throw new Error("Operation claimの応答件数が不正です");
  const row = result[0];
  if (
    typeof row.job_id !== "string" ||
    !isAction(row.operation_type) ||
    (row.job_status !== "leased" && row.job_status !== "running") ||
    typeof row.lease_expires_at !== "string"
  ) {
    throw new Error("Operation claimの応答値が不正です");
  }
  return {
    jobId: row.job_id,
    action: row.operation_type,
    status: row.job_status,
    leaseExpiresAt: row.lease_expires_at,
  };
}

export async function transitionMcMainOperationJob(input: OperationTransition): Promise<void> {
  const result = await callRpc("transition_mc_main_operation_job", {
    p_server_id: input.serverId,
    p_job_id: input.jobId,
    p_operation_type: input.action,
    p_expected_status: input.expectedStatus,
    p_new_status: input.newStatus,
    p_lease_owner: input.leaseOwner,
    p_request_id: input.requestId,
    p_details: input.details,
  });
  const row = firstRow(result, "Operation transition");
  if (row.job_id !== input.jobId || row.job_status !== input.newStatus) {
    throw new Error("Operation transitionの応答値が不正です");
  }
}
