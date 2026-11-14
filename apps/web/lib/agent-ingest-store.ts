import { AgentIngestError, parseAgentSecretMaps } from "./operation-agent-auth-core";

export type AgentIngestErrorClass = new (status: number, code: string) => AgentIngestError;

export type IngestPersistResult =
  | "accepted"
  | "unknown_agent"
  | "rate_limited"
  | "replayed_request"
  | "invalid_payload";

const INGEST_PERSIST_RESULTS: readonly IngestPersistResult[] = [
  "accepted",
  "unknown_agent",
  "rate_limited",
  "replayed_request",
  "invalid_payload",
];

export function readAgentSecrets(errorClass: AgentIngestErrorClass): Record<string, string> {
  try {
    return parseAgentSecretMaps(
      process.env.IVRM_AGENT_SECRETS_JSON,
      process.env.IVRM_AGENT_SECRETS_ADDITIONAL_JSON,
    );
  } catch {
    throw new errorClass(503, "service_not_configured");
  }
}

function requireStoreEnvironment(name: string, errorClass: AgentIngestErrorClass): string {
  const value = process.env[name];
  if (!value) {
    throw new errorClass(503, "service_not_configured");
  }
  return value;
}

export function supabaseConfiguration(errorClass: AgentIngestErrorClass): {
  url: string;
  serviceRoleKey: string;
} {
  return {
    url: requireStoreEnvironment("SUPABASE_URL", errorClass).replace(/\/$/, ""),
    serviceRoleKey: requireStoreEnvironment("SUPABASE_SERVICE_ROLE_KEY", errorClass),
  };
}

export function handleIngestPersistResult(
  result: IngestPersistResult,
  errorClass: AgentIngestErrorClass,
): void {
  if (result === "accepted") return;
  if (result === "unknown_agent") throw new errorClass(401, result);
  if (result === "rate_limited") throw new errorClass(429, result);
  if (result === "replayed_request") throw new errorClass(409, result);
  throw new errorClass(400, "invalid_payload");
}

export async function callIngestRpc(
  errorClass: AgentIngestErrorClass,
  rpcName: string,
  params: Record<string, unknown>,
): Promise<void> {
  const { url, serviceRoleKey } = supabaseConfiguration(errorClass);
  const response = await fetch(`${url}/rest/v1/rpc/${rpcName}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new errorClass(503, "storage_unavailable");
  const result = (await response.json()) as IngestPersistResult;
  if (!INGEST_PERSIST_RESULTS.includes(result)) {
    throw new errorClass(503, "storage_unavailable");
  }
  handleIngestPersistResult(result, errorClass);
}
