import type {
  ReliabilityRange,
  ReliabilitySloBudget,
  ReliabilitySloBudgetState,
} from "../../lib/reliability";
import styles from "./reliability.module.css";

type Props = {
  budgets: ReliabilitySloBudget[];
  policyDataAvailable: boolean;
  canManage: boolean;
  range: ReliabilityRange;
  outcome: string | null;
};

const STATE_LABELS: Record<ReliabilitySloBudgetState, string> = {
  unconfigured: "Not configured",
  within_budget: "Within budget",
  exhausted: "Budget exhausted",
  coverage_unknown: "Coverage unknown",
  data_unavailable: "Data unavailable",
};

const STATE_CLASSES: Record<ReliabilitySloBudgetState, string> = {
  unconfigured: styles.budgetUnconfigured,
  within_budget: styles.budgetWithin,
  exhausted: styles.budgetExhausted,
  coverage_unknown: styles.budgetUnknown,
  data_unavailable: styles.budgetUnknown,
};

const OUTCOME_MESSAGES: Record<string, string> = {
  updated: "SLO Policyを更新しました。",
  service_invalid: "SLO対象サービスが不正です。",
  target_invalid: "SLO Targetは0より大きく100未満、小数4桁以内で入力してください。",
  target_required: "SLOを有効にする場合はTargetが必要です。",
  update_failed: "SLO Policyの更新に失敗しました。",
};

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds > 0 && seconds < 1) return "<1秒";
  if (seconds < 60) return `${Math.floor(seconds)}秒`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}分 ${Math.floor(seconds % 60)}秒`;
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3_600)}時間 ${Math.floor((seconds % 3_600) / 60)}分`;
  }
  return `${Math.floor(seconds / 86_400)}日 ${Math.floor((seconds % 86_400) / 3_600)}時間`;
}

function percent(value: number | null, digits = 3): string {
  return value === null ? "—" : `${value.toFixed(digits)}%`;
}

function target(budget: ReliabilitySloBudget): string {
  if (budget.targetPercent === null) {
    return budget.state === "data_unavailable" ? "—" : "未設定";
  }
  const value = percent(budget.targetPercent, 4);
  return budget.enabled ? value : `${value} / 無効`;
}

function observed(budget: ReliabilitySloBudget): string {
  if (budget.observedAvailabilityPercent === null) return "—";
  const value = percent(budget.observedAvailabilityPercent);
  return budget.observedExact ? value : `≤ ${value}`;
}

function used(budget: ReliabilitySloBudget): string {
  if (budget.budgetUsedPercent === null) return "—";
  const value = `${budget.budgetUsedPercent.toFixed(budget.budgetUsedPercent >= 100 ? 0 : 1)}%`;
  return budget.observedExact ? value : `≥ ${value}`;
}

function remaining(budget: ReliabilitySloBudget): string {
  if (budget.remainingBudgetSeconds === null) return "—";
  const value = duration(budget.remainingBudgetSeconds);
  return budget.remainingExact ? value : `≤ ${value}`;
}

function burn(budget: ReliabilitySloBudget): string {
  if (budget.burnRate === null) return "—";
  const value = `${budget.burnRate.toFixed(budget.burnRate >= 10 ? 1 : 2)}x`;
  return budget.observedExact ? value : `≥ ${value}`;
}

function updatedAt(value: string | null): string {
  if (!value) return "未設定";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}

export function ReliabilitySloPanel({
  budgets,
  policyDataAvailable,
  canManage,
  range,
  outcome,
}: Props) {
  const message = outcome ? OUTCOME_MESSAGES[outcome] ?? null : null;

  return (
    <section id="slo-budget" aria-labelledby="slo-budget-title">
      <div className={styles.sectionTitle}>
        <div>
          <span>SLO / ERROR BUDGET</span>
          <h2 id="slo-budget-title">SLOとError Budget</h2>
        </div>
        <p>
          SLOは明示設定されたTargetだけを使用します。Coverageが未確定の場合、Budget消費は下限値、残量は上限値として表示します。
        </p>
      </div>

      {!policyDataAvailable ? (
        <div className={styles.coverage} role="status">
          SLO Policyを取得できないため、SLO / Error BudgetだけをUnknownとして継続表示しています。IncidentベースのReliability指標には影響しません。
        </div>
      ) : null}
      {message ? (
        <div className={outcome === "updated" ? styles.policySuccess : styles.policyError} role="status">
          {message}
        </div>
      ) : null}

      <div className={styles.sloGrid}>
        {budgets.map((budget) => (
          <article className={styles.sloCard} key={budget.serviceId}>
            <div className={styles.sloHead}>
              <div>
                <span>{budget.serviceId.toUpperCase()}</span>
                <h3>{budget.label}</h3>
              </div>
              <span className={`${styles.badge} ${STATE_CLASSES[budget.state]}`}>
                {STATE_LABELS[budget.state]}
              </span>
            </div>

            <div className={styles.sloMetrics}>
              <div><span>TARGET</span><strong>{target(budget)}</strong></div>
              <div><span>OBSERVED</span><strong>{observed(budget)}</strong></div>
              <div><span>ERROR BUDGET</span><strong>{duration(budget.allowedDowntimeSeconds)}</strong></div>
              <div><span>USED</span><strong>{used(budget)}</strong></div>
              <div><span>REMAINING</span><strong>{remaining(budget)}</strong></div>
              <div><span>BUDGET BURN</span><strong>{burn(budget)}</strong></div>
            </div>

            <div className={styles.sloFooter}>
              <a href={budget.detailHref}>根拠データを確認</a>
              <small>Policy更新: {updatedAt(budget.updatedAt)}</small>
            </div>

            {canManage && policyDataAvailable ? (
              <details className={styles.policyEditor}>
                <summary>SLO Policyを編集</summary>
                <form action="/api/reliability/slo" method="post">
                  <input type="hidden" name="serviceId" value={budget.serviceId} />
                  <input type="hidden" name="range" value={range} />
                  <label>
                    <span>Target (%)</span>
                    <input
                      aria-label={`${budget.label} SLO Target`}
                      defaultValue={budget.targetPercent ?? ""}
                      inputMode="decimal"
                      max="99.9999"
                      min="0.0001"
                      name="targetPercent"
                      placeholder="未設定"
                      step="0.0001"
                      type="number"
                    />
                  </label>
                  <label className={styles.policyCheckbox}>
                    <input defaultChecked={budget.enabled} name="enabled" type="checkbox" />
                    <span>SLOを有効にする</span>
                  </label>
                  <button type="submit">Policyを保存</button>
                </form>
              </details>
            ) : null}
          </article>
        ))}
      </div>

      <div className={styles.sloNote}>
        <strong>Budget Burnについて</strong>
        <p>
          選択期間のKnown Downtimeを、その期間で許容されるError Budgetで割った値です。1.00x以上はBudget超過を意味します。開始時刻不明のActive Incidentがある場合、実際のBurnは表示値以上になり得ます。Notificationは配送要求の完全な分母がまだ定義されていないため、SLO対象には含めていません。
        </p>
      </div>
    </section>
  );
}
