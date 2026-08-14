import "server-only";

import { createHash } from "node:crypto";
import { recordReliabilityBurnRateHistory } from "./reliability-burn-observability";
import { getReliabilityBurnRateSnapshot } from "./reliability-burn-rate";
import type {
  ReliabilityBurnRateService,
  ReliabilitySloServiceId,
} from "./reliability-types";

function configuration(): { url: string; serviceRoleKey: string } {
  const rawUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!rawUrl || !serviceRoleKey) {
    throw new Error("Burn Rate通知のSupabase設定が不足しています");
  }
  return { url: rawUrl.replace(/\/$/, ""), serviceRoleKey };
}

async function callRpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const { url, serviceRoleKey } = configuration();
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Burn Rate通知RPC ${name} が${response.status}を返しました`);
  }
  return response.json();
}

export async function verifyReliabilityBurnReconcileToken(token: string): Promise<boolean> {
  if (token.length < 32 || token.length > 256) return false;
  const tokenSha256 = createHash("sha256").update(token, "utf8").digest("hex");
  const result = await callRpc("verify_reliability_burn_reconcile_token_v1", {
    p_token_sha256: tokenSha256,
  });
  return result === true;
}

function signalDecision(service: ReliabilityBurnRateService): {
  action: "apply" | "skip";
  active?: boolean;
  severity?: "warning" | "critical";
  reason?: string;
} {
  switch (service.state) {
    case "critical":
      return { action: "apply", active: true, severity: "critical", reason: service.reason };
    case "warning":
      return { action: "apply", active: true, severity: "warning", reason: service.reason };
    case "healthy":
      return { action: "apply", active: false, severity: "warning", reason: service.reason };
    case "unconfigured":
      return {
        action: "apply",
        active: false,
        severity: "warning",
        reason: "SLO Policyが未設定または無効になったためBurn Alertを終了します。",
      };
    case "coverage_unknown":
    case "data_unavailable":
      return { action: "skip" };
  }
}

async function applySignal(
  serviceId: ReliabilitySloServiceId,
  active: boolean,
  severity: "warning" | "critical",
  occurredAt: string,
  reason: string,
): Promise<string> {
  const payload = await callRpc("apply_reliability_burn_signal_v1", {
    p_service_id: serviceId,
    p_active: active,
    p_severity: severity,
    p_occurred_at: occurredAt,
    p_reason: reason,
  });
  if (typeof payload !== "string") {
    throw new Error("Burn Rate通知Signal結果が不正です");
  }
  return payload;
}

export async function markReliabilityBurnReconcile(
  success: boolean,
  evaluatedCount: number,
  errorCode: string | null,
): Promise<void> {
  await callRpc("mark_reliability_burn_reconcile_v1", {
    p_success: success,
    p_evaluated_count: evaluatedCount,
    p_error_code: errorCode,
  });
}

export async function reconcileReliabilityBurnNotifications(): Promise<{
  generatedAt: string;
  evaluated: number;
  changed: number;
  skipped: number;
  historyRecorded: boolean;
}> {
  const snapshot = await getReliabilityBurnRateSnapshot();
  const historyPromise = recordReliabilityBurnRateHistory(snapshot)
    .then(() => true)
    .catch((error: unknown) => {
      console.error("Burn Rate履歴の記録に失敗しました。Alert評価は継続します", error);
      return false;
    });
  let evaluated = 0;
  let changed = 0;
  let skipped = 0;

  for (const service of snapshot.burnRates) {
    const decision = signalDecision(service);
    if (decision.action === "skip") {
      skipped += 1;
      continue;
    }

    evaluated += 1;
    const transition = await applySignal(
      service.serviceId,
      decision.active as boolean,
      decision.severity as "warning" | "critical",
      snapshot.generatedAt,
      decision.reason as string,
    );
    if (!["unchanged", "stale_ignored", "deescalated"].includes(transition)) {
      changed += 1;
    }
  }

  return {
    generatedAt: snapshot.generatedAt,
    evaluated,
    changed,
    skipped,
    historyRecorded: await historyPromise,
  };
}