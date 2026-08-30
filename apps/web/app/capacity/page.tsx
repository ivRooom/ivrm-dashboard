import { AutoRefresh } from "../../components/auto-refresh";
import {
  ActionLink,
  MetricCard,
  MetricGrid,
  PageContent,
  PageHeader,
  StatePanel,
} from "../../components/console-ui";
import { MetricLineChart } from "../../components/metric-line-chart";
import {
  CAPACITY_POLICY,
  CAPACITY_RANGE_CONFIG,
  getCapacitySnapshot,
  parseCapacityRange,
  type CapacityRange,
  type CapacityState,
  type ForecastConfidence,
} from "../../lib/capacity";
import { HISTORY_RANGE_CONFIG } from "../../lib/history";
import styles from "./capacity.module.css";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const ranges = Object.keys(CAPACITY_RANGE_CONFIG) as CapacityRange[];

const stateLabels: Record<CapacityState, string> = {
  healthy: "Healthy",
  growth: "Growth detected",
  forecast_warning: "Forecast Warning",
  forecast_critical: "Forecast Critical",
  warning: "Warning",
  critical: "Critical",
  insufficient: "Insufficient data",
};

const confidenceLabels: Record<ForecastConfidence, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  insufficient: "—",
};

function first(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function formatPercent(value: number | null, digits = 1): string {
  return value === null ? "—" : `${value.toFixed(digits)}%`;
}

function formatSlope(value: number | null): string {
  if (value === null) return "—";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(Math.abs(value) >= 10 ? 1 : 2)} pp/日`;
}

function formatDays(value: number | null): string {
  if (value === null) return "—";
  if (value <= 0) return "到達済み";
  if (value < 1) return "1日未満";
  if (value < 10) return `約${value.toFixed(1)}日`;
  return `約${Math.ceil(value)}日`;
}

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let normalized = Math.max(0, value);
  let unit = 0;
  while (normalized >= 1024 && unit < units.length - 1) {
    normalized /= 1024;
    unit += 1;
  }
  return `${normalized.toFixed(unit >= 3 ? 1 : 0)} ${units[unit]}`;
}

function formatByteGrowth(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const prefix = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${prefix}${formatBytes(Math.abs(value))}/日`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}

function stateClass(state: CapacityState): string {
  return styles[state];
}

export default async function CapacityPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const range = parseCapacityRange(first(query.range));
  const rangeConfig = CAPACITY_RANGE_CONFIG[range];
  let data = null;
  let loadError = false;

  try {
    data = await getCapacitySnapshot(range);
  } catch (error) {
    loadError = true;
    console.error("Capacity & Trend Forecastの取得に失敗しました", error);
  }

  const now = new Date();
  const startAt = new Date(now.getTime() - rangeConfig.hours * 3_600_000);
  const historyConfig = HISTORY_RANGE_CONFIG[range];
  const sourceFailures = data
    ? Object.entries(data.sources).filter(([, available]) => !available).map(([source]) => source)
    : [];

  const diskSeries = data?.hostHistory.map((host) => ({
    id: `${host.hostId}:disk`,
    label: host.hostDisplayName,
    points: host.points.map((point) => ({ timestamp: point.timestamp, value: point.diskPercent })),
  })) ?? [];
  const hostMemorySeries = data?.hostHistory.map((host) => ({
    id: `${host.hostId}:memory`,
    label: host.hostDisplayName,
    points: host.points.map((point) => ({ timestamp: point.timestamp, value: point.memoryPercent })),
  })) ?? [];
  const containerMemorySeries = data?.containerHistory.map((container) => ({
    id: `${container.hostId}:${container.containerName}:memory`,
    label: `${container.containerName} / ${container.hostDisplayName}`,
    points: container.points.map((point) => ({ timestamp: point.timestamp, value: point.memoryPercent })),
  })) ?? [];
  const containerCpuSeries = data?.containerHistory.map((container) => ({
    id: `${container.hostId}:${container.containerName}:cpu`,
    label: `${container.containerName} / ${container.hostDisplayName}`,
    points: container.points.map((point) => ({ timestamp: point.timestamp, value: point.cpuPercent })),
  })) ?? [];

  return (
    <>
      <AutoRefresh intervalMs={rangeConfig.refreshMs} />
      <PageContent>
        <div className={styles.content}>
          <PageHeader
            actions={
              <>
                <ActionLink href="/inventory">Inventory</ActionLink>
                <ActionLink href={`/history?range=${range}`}>History</ActionLink>
                <ActionLink href="/reliability">Reliability</ActionLink>
              </>
            }
            className={styles.sharedPageHeader}
            description="Host Disk・Memory、Container Memory、Backupサイズの実測履歴から増加傾向を評価し、データ品質を満たす場合だけしきい値到達の目安を表示します。"
            eyebrow="CAPACITY / TREND / FORECAST"
            title="Capacity & Trend Forecast"
          />

          <nav className={styles.periods} aria-label="キャパシティ分析期間">
            {ranges.map((candidate) => (
              <a
                key={candidate}
                aria-current={candidate === range ? "page" : undefined}
                href={`/capacity?range=${candidate}`}
              >
                {CAPACITY_RANGE_CONFIG[candidate].label}
              </a>
            ))}
          </nav>

          {loadError || !data ? (
            <StatePanel title="Capacity情報を取得できませんでした" variant="error">
              Monitoring / History / BackupのServer-side接続を確認してください。
            </StatePanel>
          ) : (
            <>
              {sourceFailures.length > 0 ? (
                <StatePanel title="一部データソースを取得できませんでした" variant="warning">
                  取得できた情報だけで継続表示しています。対象: {sourceFailures.join(" / ")}
                </StatePanel>
              ) : null}

              <MetricGrid className={styles.sharedMetricGrid} label="Capacity Forecast Summary">
                <MetricCard
                  detail="現在値または予測しきい値に注意が必要"
                  label="FORECAST ATTENTION"
                  tone={
                    data.summary.criticalCount > 0
                      ? "danger"
                      : data.summary.forecastAttentionCount > 0
                        ? "warning"
                        : "neutral"
                  }
                  value={data.summary.forecastAttentionCount}
                />
                <MetricCard
                  detail="現在 / 7日以内予測"
                  label="CRITICAL"
                  tone={data.summary.criticalCount > 0 ? "danger" : "neutral"}
                  value={data.summary.criticalCount}
                />
                <MetricCard
                  detail="現在 / 30日以内予測"
                  label="WARNING"
                  tone={data.summary.warningCount > 0 ? "warning" : "neutral"}
                  value={data.summary.warningCount}
                />
                <MetricCard
                  detail="増加傾向のみ検出"
                  label="GROWTH"
                  tone={data.summary.growthCount > 0 ? "info" : "neutral"}
                  value={data.summary.growthCount}
                />
                <MetricCard
                  detail="予測品質ゲート未達"
                  label="INSUFFICIENT"
                  tone={data.summary.insufficientCount > 0 ? "info" : "neutral"}
                  value={data.summary.insufficientCount}
                />
                <MetricCard
                  detail="容量上限は仮定しません"
                  label="BACKUP GROWTH"
                  tone={data.summary.backupGrowthCount > 0 ? "info" : "neutral"}
                  value={data.summary.backupGrowthCount}
                />
              </MetricGrid>

              <section className={styles.section} aria-labelledby="host-capacity-title">
                <div className={styles.sectionHeading}>
                  <div><span>HOST CAPACITY</span><h2 id="host-capacity-title">Host Resource Forecast</h2></div>
                  <p>最新Heartbeatを現在値に使い、Historyの傾きと品質から将来到達目安を計算します。</p>
                </div>
                <div className={styles.tableShell}>
                  <table>
                    <caption className={styles.srOnly}>Host DiskとMemoryのキャパシティ予測</caption>
                    <thead><tr><th>Host / Resource</th><th>State</th><th>Current</th><th>Headroom</th><th>Trend</th><th>Warning ETA</th><th>Critical ETA</th><th>Confidence</th></tr></thead>
                    <tbody>
                      {data.hostResources.map((resource) => (
                        <tr key={resource.id}>
                          <td>
                            {resource.detailHref ? <a href={resource.detailHref}>{resource.hostDisplayName}</a> : <strong>{resource.hostDisplayName}</strong>}
                            <small>{resource.kind === "disk" ? "Disk" : "Memory"} · Total {formatBytes(resource.totalBytes)}</small>
                          </td>
                          <td><span className={`${styles.state} ${stateClass(resource.forecast.state)}`}>{stateLabels[resource.forecast.state]}</span><small>{resource.forecast.reason}</small></td>
                          <td><strong>{formatPercent(resource.forecast.currentPercent)}</strong></td>
                          <td>{formatBytes(resource.availableBytes)}</td>
                          <td>{formatSlope(resource.forecast.slopePercentPerDay)}</td>
                          <td>{formatDays(resource.forecast.daysToWarning)}<small>{resource.forecast.warningPercent}%</small></td>
                          <td>{formatDays(resource.forecast.daysToCritical)}<small>{resource.forecast.criticalPercent}%</small></td>
                          <td><strong>{confidenceLabels[resource.forecast.confidence]}</strong><small>coverage {Math.round(resource.forecast.coverageRatio * 100)}% · R² {resource.forecast.rSquared?.toFixed(2) ?? "—"}</small></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {data.hostResources.length === 0 ? (
                  <StatePanel title="Host Capacityデータがありません">
                    Host HistoryまたはHeartbeat受信後に表示されます。
                  </StatePanel>
                ) : null}
              </section>

              <section className={styles.section} aria-labelledby="container-capacity-title">
                <div className={styles.sectionHeading}>
                  <div><span>CONTAINER MEMORY</span><h2 id="container-capacity-title">Container Memory Forecast</h2></div>
                  <p>Memory Limitを基準にした使用率を評価します。Limit不明時は履歴の最終値を利用します。</p>
                </div>
                <div className={styles.tableShell}>
                  <table>
                    <caption className={styles.srOnly}>DockerコンテナMemoryのキャパシティ予測</caption>
                    <thead><tr><th>Container</th><th>State</th><th>Current</th><th>Usage / Limit</th><th>Trend</th><th>Warning ETA</th><th>Critical ETA</th><th>Confidence</th></tr></thead>
                    <tbody>
                      {data.containerResources.map((resource) => (
                        <tr key={resource.id}>
                          <td>
                            {resource.detailHref ? <a href={resource.detailHref}>{resource.containerName}</a> : <strong>{resource.containerName}</strong>}
                            <small>{resource.hostDisplayName}</small>
                          </td>
                          <td><span className={`${styles.state} ${stateClass(resource.forecast.state)}`}>{stateLabels[resource.forecast.state]}</span><small>{resource.forecast.reason}</small></td>
                          <td><strong>{formatPercent(resource.forecast.currentPercent)}</strong></td>
                          <td>{formatBytes(resource.memoryUsageBytes)} / {formatBytes(resource.memoryLimitBytes)}</td>
                          <td>{formatSlope(resource.forecast.slopePercentPerDay)}</td>
                          <td>{formatDays(resource.forecast.daysToWarning)}</td>
                          <td>{formatDays(resource.forecast.daysToCritical)}</td>
                          <td><strong>{confidenceLabels[resource.forecast.confidence]}</strong><small>{resource.forecast.validPointCount} samples · R² {resource.forecast.rSquared?.toFixed(2) ?? "—"}</small></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {data.containerResources.length === 0 ? (
                  <StatePanel title="Container Capacityデータがありません">
                    Container History受信後に表示されます。
                  </StatePanel>
                ) : null}
              </section>

              <section className={styles.section} aria-labelledby="trend-title">
                <div className={styles.sectionHeading}>
                  <div><span>TREND CHARTS</span><h2 id="trend-title">Utilization Trends</h2></div>
                  <p>予測値そのものではなく、予測判定に使った実測推移を同じ画面で確認できます。</p>
                </div>
                <div className={styles.chartGrid}>
                  <MetricLineChart
                    title="Host Disk Usage"
                    description="監視対象ファイルシステムの使用率。Forecastはこの履歴に品質ゲートを適用します。"
                    series={diskSeries}
                    startAt={startAt.toISOString()}
                    endAt={now.toISOString()}
                    expectedIntervalSeconds={historyConfig.bucketSeconds}
                    aggregationLabel={historyConfig.aggregationLabel}
                    periodLabel={rangeConfig.label}
                    unit="%"
                    maximum={100}
                  />
                  <MetricLineChart
                    title="Host Memory Usage"
                    description="総MemoryとAvailableから算出した使用率の推移です。"
                    series={hostMemorySeries}
                    startAt={startAt.toISOString()}
                    endAt={now.toISOString()}
                    expectedIntervalSeconds={historyConfig.bucketSeconds}
                    aggregationLabel={historyConfig.aggregationLabel}
                    periodLabel={rangeConfig.label}
                    unit="%"
                    maximum={100}
                  />
                  <MetricLineChart
                    title="Container Memory Usage"
                    description="各ContainerのMemory Limitに対する使用率です。"
                    series={containerMemorySeries}
                    startAt={startAt.toISOString()}
                    endAt={now.toISOString()}
                    expectedIntervalSeconds={historyConfig.bucketSeconds}
                    aggregationLabel={historyConfig.aggregationLabel}
                    periodLabel={rangeConfig.label}
                    unit="%"
                    maximum={100}
                  />
                  <MetricLineChart
                    title="Container CPU Trend"
                    description="CPUは枯渇日を算出せず、負荷傾向を観測するための補助指標として表示します。"
                    series={containerCpuSeries}
                    startAt={startAt.toISOString()}
                    endAt={now.toISOString()}
                    expectedIntervalSeconds={historyConfig.bucketSeconds}
                    aggregationLabel={historyConfig.aggregationLabel}
                    periodLabel={rangeConfig.label}
                    unit="%"
                  />
                </div>
              </section>

              <section className={styles.section} aria-labelledby="backup-growth-title">
                <div className={styles.sectionHeading}>
                  <div><span>BACKUP GROWTH</span><h2 id="backup-growth-title">Backup Size Trend</h2></div>
                  <p>成功BackupのsizeBytesだけを利用します。S3やLocalのQuotaを取得していないため、容量枯渇日は推測しません。</p>
                </div>
                <div className={styles.tableShell}>
                  <table>
                    <caption className={styles.srOnly}>Backupサイズ増減傾向</caption>
                    <thead><tr><th>Target</th><th>Trend</th><th>Latest Size</th><th>Growth / day</th><th>Relative</th><th>Confidence</th><th>Samples</th></tr></thead>
                    <tbody>
                      {data.backupGrowth.map((item) => (
                        <tr key={item.id}>
                          <td><a href="/backups">{item.backupTarget}</a><small>{item.hostDisplayName}</small></td>
                          <td><span className={`${styles.state} ${styles[`backup_${item.state}`]}`}>{item.state === "growth" ? "Growth" : item.state === "shrinking" ? "Shrinking" : item.state === "stable" ? "Stable" : "Insufficient data"}</span><small>{item.reason}</small></td>
                          <td>{formatBytes(item.latestSizeBytes)}</td>
                          <td>{formatByteGrowth(item.growthBytesPerDay)}</td>
                          <td>{item.growthPercentPerDay === null ? "—" : `${item.growthPercentPerDay > 0 ? "+" : ""}${item.growthPercentPerDay.toFixed(2)}%/日`}</td>
                          <td><strong>{confidenceLabels[item.confidence]}</strong><small>R² {item.rSquared?.toFixed(2) ?? "—"}</small></td>
                          <td>{item.sampleCount}<small>span {Math.round(item.spanRatio * 100)}%</small></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {data.backupGrowth.length === 0 ? (
                  <StatePanel title="Backupサイズ履歴がありません">
                    ReporterからsizeBytesを含む成功Runが蓄積されると傾向を表示します。
                  </StatePanel>
                ) : null}
              </section>

              <section className={styles.policy} aria-labelledby="forecast-policy-title">
                <div>
                  <span>FORECAST POLICY</span>
                  <h2 id="forecast-policy-title">予測を断定しないための品質ゲート</h2>
                </div>
                <ul>
                  <li>Disk: Warning {CAPACITY_POLICY.disk.warningPercent}% / Critical {CAPACITY_POLICY.disk.criticalPercent}%</li>
                  <li>Memory: Warning {CAPACITY_POLICY.memory.warningPercent}% / Critical {CAPACITY_POLICY.memory.criticalPercent}%</li>
                  <li>最低 {CAPACITY_POLICY.forecast.minimumPointCount} points、Coverage {Math.round(CAPACITY_POLICY.forecast.minimumCoverageRatio * 100)}%以上、観測Span {Math.round(CAPACITY_POLICY.forecast.minimumSpanRatio * 100)}%以上</li>
                  <li>R² {CAPACITY_POLICY.forecast.minimumRSquared.toFixed(2)}未満は将来到達日を表示せず「Insufficient data」とします</li>
                  <li>Warning予測は{CAPACITY_POLICY.forecast.warningHorizonDays}日以内、Critical予測は{CAPACITY_POLICY.forecast.criticalHorizonDays}日以内のみAttentionへ昇格します</li>
                  <li>BackupはStorage Quota未取得のため、サイズ増減だけを示し枯渇日を生成しません</li>
                </ul>
                <small>Generated {formatDateTime(data.generatedAt)} · 過去傾向が今後も続く保証はありません。</small>
              </section>
            </>
          )}
        </div>
      </PageContent>
    </>
  );
}
