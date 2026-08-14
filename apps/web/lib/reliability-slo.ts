import "server-only";

import { INCIDENT_RANGE_CONFIG } from "./unified-incidents";
import type {
  ReliabilityRange,
  ReliabilityService,
  ReliabilitySloBudget,
  ReliabilitySloPolicy,
  ReliabilitySloServiceId,
  ReliabilitySnapshot,
} from "./reliability-types";

const SLO_SERVICE_IDS: ReliabilitySloServiceId[] = [
  "overall",
  "host",
  "container",
  "backup",
];

const SLO_LABELS: Record<ReliabilitySloServiceId, string> = {
  overall: "Overall Reliability",
  host: "Host Platform",
  container: "Container Runtime",
  backup: "Backup Protection",
};

type PolicyRow = {
  service_id: unknown;
  target_percent: unknown;
  enabled: unknown;
  updated_at: unknown;
};

type ReliabilitySource = {
  label: string;
  knownDowntimeSeconds: number | null;
  incidentFreeRatio: number | null;
  exactCoverage: boolean;
  detailHref: string;
};

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}が設定されていません`);
  return value;
}

function supabaseConfiguration(): { url: string; serviceRoleKey: string } {
  return {
    url: requireEnvironment("SUPABASE_URL").replace(/\/$/, ""),
    serviceRoleKey: requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

function isSloServiceId(value: unknown): value is ReliabilitySloServiceId {
  return typeof value === "string" && SLO_SERVICE_IDS.includes(value as ReliabilitySloServiceId);
}

function parseTargetPercent(value: unknown): number | null | undefined {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) return undefined;
  return parsed;
}

function parseTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function parsePolicy(row: PolicyRow): ReliabilitySloPolicy {
  const targetPercent = parseTargetPercent(row.target_percent);
  const updatedAt = parseTimestamp(row.updated_at);
  if (
    !isSloServiceId(row.service_id) ||
    targetPercent === undefined ||
    typeof row.enabled !== "boolean" ||
    !updatedAt ||
    (row.enabled && targetPercent === null)
  ) {
    throw new Error("Reliability SLO Policyレスポンス形式が不正です");
  }
  return {
    serviceId: row.service_id,
    targetPercent,
    enabled: row.enabled,
    updatedAt,
  };
}

function requestHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function parseSinglePolicyPayload(payload: unknown, context: string): ReliabilitySloPolicy {
  if (!Array.isArray(payload) || payload.length !== 1) {
    throw new Error(`${context}が不正です`);
  }
  const row = payload[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`${context}行が不正です`);
  }
  return parsePolicy(row as PolicyRow);
}

export async function getReliabilitySloPolicies(): Promise<ReliabilitySloPolicy[]> {
  const { url, serviceRoleKey } = supabaseConfiguration();
  const response = await fetch(
    `${url}/rest/v1/reliability_slo_policies?select=service_id,target_percent,enabled,updated_at&order=service_id.asc`,
    {
      headers: requestHeaders(serviceRoleKey),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Reliability SLO Policy APIが${response.status}を返しました`);
  }
  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error("Reliability SLO Policyレスポンスが配列ではありません");
  }
  return payload.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("Reliability SLO Policy行が不正です");
    }
    return parsePolicy(row as PolicyRow);
  });
}

export async function updateReliabilitySloPolicy(input: {
  serviceId: ReliabilitySloServiceId;
  targetPercent: number | null;
  enabled: boolean;
  requestId: string;
  actorEmail: string | null;
  actorRole: "administrator" | "owner";
}): Promise<ReliabilitySloPolicy> {
  if (!isSloServiceId(input.serviceId)) {
    throw new Error("SLO serviceIdが不正です");
  }
  if (
    input.targetPercent !== null &&
    (!Number.isFinite(input.targetPercent) || input.targetPercent <= 0 || input.targetPercent >= 100)
  ) {
    throw new Error("SLO targetPercentが不正です");
  }
  if (input.enabled && input.targetPercent === null) {
    throw new Error("有効なSLOにはtargetPercentが必要です");
  }
  if (!/^[0-9a-f-]{36}$/i.test(input.requestId)) {
    throw new Error("SLO requestIdが不正です");
  }

  const { url, serviceRoleKey } = supabaseConfiguration();
  const response = await fetch(`${url}/rest/v1/rpc/update_reliability_slo_policy_v1`, {
    method: "POST",
    headers: requestHeaders(serviceRoleKey),
    body: JSON.stringify({
      p_service_id: input.serviceId,
      p_target_percent: input.targetPercent,
      p_enabled: input.enabled,
      p_request_id: input.requestId,
      p_actor_email: input.actorEmail,
      p_actor_role: input.actorRole,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Reliability SLO Policy更新RPCが${response.status}を返しました`);
  }
  return parseSinglePolicyPayload(
    (await response.json()) as unknown,
    "Reliability SLO Policy更新結果",
  );
}

function sourceFor(
  serviceId: ReliabilitySloServiceId,
  services: ReliabilityService[],
  overall: ReliabilitySnapshot["overall"],
  range: ReliabilityRange,
): ReliabilitySource | null {
  if (serviceId === "overall") {
    return {
      label: SLO_LABELS.overall,
      knownDowntimeSeconds: overall.knownDowntimeSeconds,
      incidentFreeRatio: overall.incidentFreeRatio,
      exactCoverage: overall.exactCoverage,
      detailHref: `/incidents?range=${range}`,
    };
  }
  const service = services.find((candidate) => candidate.id === serviceId);
  if (!service) return null;
  return {
    label: service.label,
    knownDowntimeSeconds: service.knownDowntimeSeconds,
    incidentFreeRatio: service.incidentFreeRatio,
    exactCoverage: service.exactCoverage,
    detailHref: service.detailHref,
  };
}

export function buildReliabilitySloBudgets(
  services: ReliabilityService[],
  overall: ReliabilitySnapshot["overall"],
  policies: ReliabilitySloPolicy[] | null,
  range: ReliabilityRange,
): ReliabilitySloBudget[] {
  const policyByService = new Map((policies ?? []).map((policy) => [policy.serviceId, policy]));
  const rangeSeconds = INCIDENT_RANGE_CONFIG[range].hours * 3_600;

  return SLO_SERVICE_IDS.map((serviceId) => {
    const policy = policyByService.get(serviceId) ?? null;
    const source = sourceFor(serviceId, services, overall, range);
    const observedAvailabilityPercent =
      source?.incidentFreeRatio === null || source?.incidentFreeRatio === undefined
        ? null
        : source.incidentFreeRatio * 100;
    const base = {
      serviceId,
      label: source?.label ?? SLO_LABELS[serviceId],
      targetPercent: policy?.targetPercent ?? null,
      enabled: policy?.enabled ?? false,
      updatedAt: policy?.updatedAt ?? null,
      observedAvailabilityPercent,
      observedExact: source?.exactCoverage ?? false,
      knownDowntimeSeconds: source?.knownDowntimeSeconds ?? null,
      detailHref: source?.detailHref ?? `/reliability?range=${range}`,
    };

    if (policies === null) {
      return {
        ...base,
        state: "data_unavailable" as const,
        allowedDowntimeSeconds: null,
        remainingBudgetSeconds: null,
        remainingExact: false,
        budgetUsedPercent: null,
        burnRate: null,
      };
    }

    if (!policy || !policy.enabled || policy.targetPercent === null) {
      return {
        ...base,
        state: "unconfigured" as const,
        allowedDowntimeSeconds: null,
        remainingBudgetSeconds: null,
        remainingExact: false,
        budgetUsedPercent: null,
        burnRate: null,
      };
    }

    if (!source || source.knownDowntimeSeconds === null || source.incidentFreeRatio === null) {
      return {
        ...base,
        state: "data_unavailable" as const,
        allowedDowntimeSeconds: rangeSeconds * (1 - policy.targetPercent / 100),
        remainingBudgetSeconds: null,
        remainingExact: false,
        budgetUsedPercent: null,
        burnRate: null,
      };
    }

    const allowedDowntimeSeconds = rangeSeconds * (1 - policy.targetPercent / 100);
    const burnRate = source.knownDowntimeSeconds / allowedDowntimeSeconds;
    const exhausted = burnRate >= 1;
    return {
      ...base,
      state: exhausted
        ? "exhausted"
        : source.exactCoverage
          ? "within_budget"
          : "coverage_unknown",
      allowedDowntimeSeconds,
      remainingBudgetSeconds: Math.max(0, allowedDowntimeSeconds - source.knownDowntimeSeconds),
      remainingExact: source.exactCoverage || exhausted,
      budgetUsedPercent: burnRate * 100,
      burnRate,
    };
  });
}
