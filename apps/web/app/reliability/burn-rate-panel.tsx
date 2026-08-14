import {
  RELIABILITY_BURN_POLICY,
} from "../../lib/reliability-burn-rate";
import type {
  ReliabilityBurnRateService,
  ReliabilityBurnRateState,
  ReliabilityBurnWindowId,
} from "../../lib/reliability";
import styles from "./reliability.module.css";

type Props = {
  burnRates: ReliabilityBurnRateService[];
};

const STATE_LABELS: Record<ReliabilityBurnRateState, string> = {
  unconfigured: "Not configured",
  healthy: "Within threshold",
  warning: "Sustained burn",
  critical: "Fast burn",
  coverage_unknown: "Coverage unknown",
  data_unavailable: "Data unavailable",
};

const STATE_CLASSES: Record<ReliabilityBurnRateState, string> = {
  unconfigured: styles.budgetUnconfigured,
  healthy: styles.budgetWithin,
  warning: styles.budgetUnknown,
  critical: styles.budgetExhausted,
  coverage_unknown: styles.budgetUnknown,
  data_unavailable: styles.budgetUnknown,
};

function burn(service: ReliabilityBurnRateService, id: ReliabilityBurnWindowId): string {
  const window = service.windows.find((candidate) => candidate.windowId === id);
  if (!window || window.burnRate === null) return "—";
  const value = `${window.burnRate.toFixed(window.burnRate >= 10 ? 1 : 2)}x`;
  return window.exactCoverage ? value : `≥ ${value}`;
}

function counted(service: ReliabilityBurnRateService, id: ReliabilityBurnWindowId): string {
  const window = service.windows.find((candidate) => candidate.windowId === id);
  if (!window || window.countedDowntimeSeconds === null) return "—";
  const seconds = window.countedDowntimeSeconds;
  if (seconds > 0 && seconds < 1) return "<1秒";
  if (seconds < 60) return `${Math.floor(seconds)}秒`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}分 ${Math.floor(seconds % 60)}秒`;
  return `${Math.floor(seconds / 3_600)}時間 ${Math.floor((seconds % 3_600) / 60)}分`;
}

function windowLabel(id: ReliabilityBurnWindowId): string {
  return id.toUpperCase();
}

export function ReliabilityBurnRatePanel({ burnRates }: Props) {
  return (
    <section id="burn-rate" aria-labelledby="burn-rate-title">
      <div className={styles.sectionTitle}>
        <div>
          <span>MULTI-WINDOW BURN RATE</span>
          <h2 id="burn-rate-title">Error Budgetの消費速度</h2>
        </div>
        <p>
          1h / 6h / 24hを同時評価し、短時間の急激なBurnと継続的なBurnを分離します。Coverage不足ではRecoveryを推測しません。
        </p>
      </div>

      <div className={styles.sloGrid}>
        {burnRates.map((service) => (
          <article className={styles.sloCard} key={service.serviceId}>
            <div className={styles.sloHead}>
              <div>
                <span>{service.serviceId.toUpperCase()} / BURN</span>
                <h3>{service.label}</h3>
              </div>
              <span className={`${styles.badge} ${STATE_CLASSES[service.state]}`}>
                {STATE_LABELS[service.state]}
              </span>
            </div>

            <div className={styles.sloAdjustment} aria-label={`${service.label} Burn Rate`}>
              {(["1h", "6h", "24h"] as ReliabilityBurnWindowId[]).map((windowId) => (
                <div key={windowId}>
                  <span>{windowLabel(windowId)} BURN</span>
                  <strong>{burn(service, windowId)}</strong>
                  <small>SLO-counted {counted(service, windowId)}</small>
                </div>
              ))}
            </div>

            <div className={styles.sloFooter}>
              <a href="/reliability?range=24h#slo-budget">SLO停止時間を確認</a>
              <small>{service.reason}</small>
            </div>
          </article>
        ))}
      </div>

      <div className={styles.sloNote}>
        <strong>IVRM Burn Alert Policy</strong>
        <p>
          Criticalは{RELIABILITY_BURN_POLICY.critical.shortWindow.toUpperCase()} ≥ {RELIABILITY_BURN_POLICY.critical.shortThreshold}x かつ {RELIABILITY_BURN_POLICY.critical.longWindow.toUpperCase()} ≥ {RELIABILITY_BURN_POLICY.critical.longThreshold}x、Warningは{RELIABILITY_BURN_POLICY.warning.shortWindow.toUpperCase()} ≥ {RELIABILITY_BURN_POLICY.warning.shortThreshold}x かつ {RELIABILITY_BURN_POLICY.warning.longWindow.toUpperCase()} ≥ {RELIABILITY_BURN_POLICY.warning.longThreshold}xです。正の判定に必要なWindowのCoverageが確定している場合だけAlertを発火し、Recoveryは1h / 6h / 24hすべて確定した場合だけ許可します。
        </p>
      </div>
    </section>
  );
}
