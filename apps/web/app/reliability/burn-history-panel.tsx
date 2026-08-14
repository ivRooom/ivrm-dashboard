import type {
  ReliabilityBurnRateHistory,
  ReliabilityBurnRateHistoryPoint,
  ReliabilityBurnRateState,
  ReliabilityBurnReconcilerHealth,
  ReliabilityBurnReconcilerState,
  ReliabilitySloServiceId,
} from "../../lib/reliability";
import styles from "./reliability.module.css";

type Props = {
  generatedAt: string;
  history: ReliabilityBurnRateHistory;
  reconciler: ReliabilityBurnReconcilerState;
};

type SeriesKey = "burnRate1h" | "burnRate6h" | "burnRate24h";
type ExactKey = "exact1h" | "exact6h" | "exact24h";

const SERVICE_LABELS: Record<ReliabilitySloServiceId, string> = {
  overall: "Overall Reliability",
  host: "Host Platform",
  container: "Container Runtime",
  backup: "Backup Protection",
};

const HEALTH_LABELS: Record<ReliabilityBurnReconcilerHealth, string> = {
  operational: "正常",
  degraded: "遅延",
  critical: "異常",
  disabled: "停止",
  unknown: "不明",
};

const STATE_LABELS: Record<ReliabilityBurnRateState, string> = {
  unconfigured: "SLO未設定",
  healthy: "正常",
  warning: "Sustained Burn",
  critical: "Fast Burn",
  coverage_unknown: "Coverage不明",
  data_unavailable: "Data unavailable",
};

const SERIES: ReadonlyArray<{
  key: SeriesKey;
  exactKey: ExactKey;
  label: string;
  className: string;
}> = [
  { key: "burnRate1h", exactKey: "exact1h", label: "1H", className: styles.historyLine1h },
  { key: "burnRate6h", exactKey: "exact6h", label: "6H", className: styles.historyLine6h },
  { key: "burnRate24h", exactKey: "exact24h", label: "24H", className: styles.historyLine24h },
];

const WIDTH = 600;
const HEIGHT = 150;
const PADDING_X = 12;
const PADDING_Y = 12;

function time(value: string | null): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(parsed));
}

function age(value: string | null, generatedAt: string): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  const reference = Date.parse(generatedAt);
  if (!Number.isFinite(timestamp) || !Number.isFinite(reference)) return "—";
  const seconds = Math.max(0, Math.floor((reference - timestamp) / 1000));
  if (seconds < 60) return `${seconds}秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  return `${Math.floor(seconds / 3600)}時間前`;
}

function rate(value: number | null, exact: boolean): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${exact ? "" : "≥"}${value.toFixed(digits)}x`;
}

function seriesValue(point: ReliabilityBurnRateHistoryPoint, key: SeriesKey): number | null {
  const value = point[key];
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

function servicePoints(
  history: ReliabilityBurnRateHistory,
  serviceId: ReliabilitySloServiceId,
): ReliabilityBurnRateHistoryPoint[] {
  return history.points
    .filter((point) => point.serviceId === serviceId)
    .sort((left, right) => Date.parse(left.bucketStartedAt) - Date.parse(right.bucketStartedAt));
}

function chartSegments(
  points: ReliabilityBurnRateHistoryPoint[],
  key: SeriesKey,
  exactKey: ExactKey,
  bucketMinutes: number,
  xMin: number,
  xMax: number,
  yMax: number,
): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  let previousAt: number | null = null;
  const maxGapMs = bucketMinutes * 60_000 * 1.6;

  for (const point of points) {
    const at = Date.parse(point.bucketStartedAt);
    const value = seriesValue(point, key);
    const valid = Number.isFinite(at) && value !== null && point[exactKey];
    const continuous = previousAt !== null && at - previousAt <= maxGapMs;
    if (!valid || (current.length > 0 && !continuous)) {
      if (current.length >= 2) segments.push(current.join(" "));
      current = [];
    }
    if (!valid || value === null) {
      previousAt = null;
      continue;
    }

    const xRatio = xMax > xMin ? (at - xMin) / (xMax - xMin) : 0.5;
    const yRatio = yMax > 0 ? Math.min(1, value / yMax) : 0;
    const x = PADDING_X + xRatio * (WIDTH - PADDING_X * 2);
    const y = HEIGHT - PADDING_Y - yRatio * (HEIGHT - PADDING_Y * 2);
    current.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    previousAt = at;
  }
  if (current.length >= 2) segments.push(current.join(" "));
  return segments;
}

function BurnChart({
  points,
  bucketMinutes,
  label,
}: {
  points: ReliabilityBurnRateHistoryPoint[];
  bucketMinutes: number;
  label: string;
}) {
  const exactValues = SERIES.flatMap((series) =>
    points
      .filter((point) => point[series.exactKey])
      .map((point) => seriesValue(point, series.key))
      .filter((value): value is number => value !== null),
  );
  if (points.length < 2 || exactValues.length < 2) return null;

  const timestamps = points
    .map((point) => Date.parse(point.bucketStartedAt))
    .filter(Number.isFinite);
  const xMin = Math.min(...timestamps);
  const xMax = Math.max(...timestamps);
  const rawMax = Math.max(...exactValues);
  const yMax = rawMax <= 0 ? 1 : rawMax * 1.08;

  return (
    <svg
      className={styles.historyChart}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-labelledby={`burn-history-${points[0]?.serviceId}-title burn-history-${points[0]?.serviceId}-desc`}
    >
      <title id={`burn-history-${points[0]?.serviceId}-title`}>{label} Burn Rate履歴</title>
      <desc id={`burn-history-${points[0]?.serviceId}-desc`}>
        1時間、6時間、24時間の確定Coverageだけを線で結んだBurn Rate推移です。欠損区間は接続しません。
      </desc>
      <line className={styles.historyAxis} x1={PADDING_X} y1={HEIGHT - PADDING_Y} x2={WIDTH - PADDING_X} y2={HEIGHT - PADDING_Y} />
      <line className={styles.historyAxis} x1={PADDING_X} y1={PADDING_Y} x2={PADDING_X} y2={HEIGHT - PADDING_Y} />
      {SERIES.flatMap((series) =>
        chartSegments(points, series.key, series.exactKey, bucketMinutes, xMin, xMax, yMax).map(
          (segment, index) => (
            <polyline
              key={`${series.key}-${index}`}
              className={series.className}
              points={segment}
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          ),
        ),
      )}
    </svg>
  );
}

export function ReliabilityBurnHistoryPanel({ generatedAt, history, reconciler }: Props) {
  const serviceIds: ReliabilitySloServiceId[] = ["overall", "host", "container", "backup"];

  return (
    <section id="burn-observability" aria-labelledby="burn-observability-title">
      <div className={styles.sectionTitle}>
        <div><span>BURN OBSERVABILITY</span><h2 id="burn-observability-title">Burn Rate履歴 / Reconciler</h2></div>
        <p>Alert評価ジョブの鮮度とBurn Rateの推移を確認します。履歴は観測用で、Alert判定のSource of Truthには使用しません。</p>
      </div>

      <article className={styles.burnOps} aria-label="Burn Reconciler稼働状態">
        <div className={styles.burnOpsHead}>
          <div><span>ONE-MINUTE RECONCILER</span><h3>Burn Alert Evaluator</h3><p>{reconciler.reason}</p></div>
          <span className={`${styles.badge} ${styles[reconciler.health]}`}>{HEALTH_LABELS[reconciler.health]}</span>
        </div>
        <div className={styles.burnOpsGrid}>
          <div><span>ENABLED</span><strong>{reconciler.enabled === null ? "—" : reconciler.enabled ? "ON" : "OFF"}</strong></div>
          <div><span>ENDPOINT</span><strong>{reconciler.endpointConfigured === null ? "—" : reconciler.endpointConfigured ? "Ready" : "Missing"}</strong></div>
          <div><span>LAST SUCCESS</span><strong>{age(reconciler.lastSuccessAt, generatedAt)}</strong><small>{time(reconciler.lastSuccessAt)}</small></div>
          <div><span>LAST INVOKED</span><strong>{age(reconciler.lastInvokedAt, generatedAt)}</strong><small>{time(reconciler.lastInvokedAt)}</small></div>
          <div><span>EVALUATED</span><strong>{reconciler.lastEvaluatedCount ?? "—"}</strong><small>最大4サービス</small></div>
          <div><span>LAST ERROR</span><strong>{reconciler.lastErrorCode ?? "—"}</strong><small>{time(reconciler.lastErrorAt)}</small></div>
        </div>
        {!reconciler.dataAvailable ? <p className={styles.burnOpsWarning} role="alert">Reconciler状態を取得できないため、画面上では稼働正常性を確定できません。</p> : null}
      </article>

      {!history.dataAvailable ? (
        <div className={styles.historyUnavailable} role="alert"><strong>Burn Rate履歴を取得できません</strong><p>現在値とAlert評価は継続しています。履歴RPCまたはデータ接続を確認してください。</p></div>
      ) : (
        <div className={styles.historyGrid}>
          {serviceIds.map((serviceId) => {
            const points = servicePoints(history, serviceId);
            const latest = points.at(-1) ?? null;
            const hasBurnValue = points.some((point) =>
              [point.burnRate1h, point.burnRate6h, point.burnRate24h].some((value) => value !== null),
            );
            return (
              <article className={styles.historyCard} key={serviceId}>
                <div className={styles.historyHead}>
                  <div><span>{serviceId.toUpperCase()} / TREND</span><h3>{SERVICE_LABELS[serviceId]}</h3></div>
                  <span className={`${styles.badge} ${latest ? styles[latest.state === "healthy" ? "operational" : latest.state === "warning" || latest.state === "coverage_unknown" ? "degraded" : latest.state === "critical" || latest.state === "data_unavailable" ? "critical" : "disabled"] : styles.unknown}`}>
                    {latest ? STATE_LABELS[latest.state] : "収集中"}
                  </span>
                </div>
                <div className={styles.historyLatest} aria-label={`${SERVICE_LABELS[serviceId]} 最新Burn Rate`}>
                  <div><span>1H</span><strong>{latest ? rate(latest.burnRate1h, latest.exact1h) : "—"}</strong></div>
                  <div><span>6H</span><strong>{latest ? rate(latest.burnRate6h, latest.exact6h) : "—"}</strong></div>
                  <div><span>24H</span><strong>{latest ? rate(latest.burnRate24h, latest.exact24h) : "—"}</strong></div>
                </div>
                {points.length === 0 ? (
                  <p className={styles.historyEmpty}>履歴を収集中です。Phase 4デプロイ後のReconcileから5分バケットへ蓄積します。</p>
                ) : !hasBurnValue ? (
                  <p className={styles.historyEmpty}>SLO Policyが未設定のためBurn値はまだありません。稼働状態の履歴だけを保持しています。</p>
                ) : (
                  <BurnChart points={points} bucketMinutes={history.bucketMinutes} label={SERVICE_LABELS[serviceId]} />
                )}
                <div className={styles.historyFoot}>
                  <span>{history.bucketMinutes}分粒度 / {points.length} points</span>
                  <span>Latest {latest ? time(latest.observedAt) : "—"}</span>
                </div>
                <div className={styles.historyLegend} aria-label="グラフ凡例">
                  <span className={styles.legend1h}>1H</span><span className={styles.legend6h}>6H</span><span className={styles.legend24h}>24H</span><small>確定Coverageのみ接続</small>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}