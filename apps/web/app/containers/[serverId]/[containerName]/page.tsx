import { notFound } from "next/navigation";
import { AutoRefresh } from "../../../../components/auto-refresh";
import { ContainerEventPanel } from "../../../../components/container-event-panel";
import {
  ActionLink,
  MetricCard,
  MetricGrid,
  PageContent,
  PageHeader,
  SectionHeader,
  StatePanel,
  StatusBadge,
  type ConsoleTone,
} from "../../../../components/console-ui";
import {
  MetricLineChart,
  type MetricChartMarker,
} from "../../../../components/metric-line-chart";
import {
  HISTORY_RANGE_CONFIG,
  getContainerMetricHistory,
  parseHistoryRange,
  type ContainerMetricHistoryPoint,
  type ContainerMetricHistorySeries,
  type HistoryDataSource,
  type HistoryRange,
} from "../../../../lib/history";
import {
  getMonitoringEvents,
  type MonitoringEvent,
  type MonitoringEventType,
} from "../../../../lib/monitoring-events";
import {
  getMonitoringSnapshot,
  type ContainerExpectedState,
  type ContainerHealth,
  type ContainerOverview,
  type ContainerState,
  type ContainerStatus,
  type HostOverview,
} from "../../../../lib/monitoring";
import styles from "../../containers.module.css";

export const dynamic = "force-dynamic";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const statusLabels: Record<ContainerStatus, string> = {
  online: "稼働中",
  offline: "受信停止",
  stale: "更新遅延",
  error: "異常",
  standby: "待機中",
  maintenance: "メンテナンス",
};

function statusTone(status: ContainerStatus): ConsoleTone {
  if (status === "online") return "success";
  if (status === "standby") return "info";
  if (status === "maintenance") return "maintenance";
  if (status === "stale") return "warning";
  return "danger";
}

const stateLabels: Record<ContainerState, string> = {
  created: "作成済み",
  running: "実行中",
  paused: "一時停止",
  restarting: "再起動中",
  removing: "削除中",
  exited: "終了",
  dead: "異常終了",
  unknown: "不明",
  not_found: "未作成",
};

const healthLabels: Record<ContainerHealth, string> = {
  starting: "確認中",
  healthy: "正常",
  unhealthy: "異常",
  none: "未設定",
  unknown: "不明",
};

const expectedStateLabels: Record<ContainerExpectedState, string> = {
  running: "稼働",
  stopped: "停止",
  absent: "未作成",
};

const dataSourceLabels: Record<HistoryDataSource, string> = {
  raw: "生データ",
  rollup_5m: "5分ロールアップ",
};

const eventMarkerLabels: Record<MonitoringEventType, string> = {
  state_changed: "State変化",
  health_changed: "Health変化",
  restart_count_increased: "RestartCount増加",
  oom_killed: "OOMKilled",
  exit_code_changed: "ExitCode変化",
  maintenance_started: "Maintenance開始",
  maintenance_ended: "Maintenance終了",
};

type PageProps = {
  params: Promise<{ serverId: string; containerName: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "未取得";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 1 : 2)} ${units[unitIndex]}`;
}

function memoryPercent(container: ContainerOverview): number | null {
  if (
    container.memoryUsageBytes === null ||
    container.memoryLimitBytes === null ||
    container.memoryLimitBytes <= 0
  ) {
    return null;
  }
  return (container.memoryUsageBytes / container.memoryLimitBytes) * 100;
}

function formatMemory(container: ContainerOverview): string {
  const percent = memoryPercent(container);
  if (
    percent === null ||
    container.memoryUsageBytes === null ||
    container.memoryLimitBytes === null
  ) {
    return "未取得";
  }
  return `${formatBytes(container.memoryUsageBytes)} / ${formatBytes(container.memoryLimitBytes)} (${percent.toFixed(1)}%)`;
}

function formatRelativeTime(timestamp: string, reference: string): string {
  const target = Date.parse(timestamp);
  const now = Date.parse(reference);
  if (!Number.isFinite(target) || !Number.isFinite(now)) return "時刻不明";
  const ageSeconds = Math.max(0, Math.floor((now - target) / 1_000));
  if (ageSeconds < 60) return `${ageSeconds}秒前`;
  if (ageSeconds < 3_600) return `${Math.floor(ageSeconds / 60)}分前`;
  if (ageSeconds < 86_400) return `${Math.floor(ageSeconds / 3_600)}時間前`;
  return `${Math.floor(ageSeconds / 86_400)}日前`;
}

function formatDateTime(timestamp: string | null): string {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "未設定";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(timestamp));
}

function formatExpectedState(value: ContainerExpectedState | null): string {
  return value ? expectedStateLabels[value] : "未設定";
}

function formatExit(container: ContainerOverview): string {
  if (container.oomKilled) return "OOMKilled";
  return container.exitCode === null ? "—" : `Code ${container.exitCode}`;
}

function peak(
  points: ContainerMetricHistoryPoint[],
  selector: (point: ContainerMetricHistoryPoint) => number | null,
): number | null {
  const values = points
    .map(selector)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : null;
}

function latest(
  points: ContainerMetricHistoryPoint[],
  selector: (point: ContainerMetricHistoryPoint) => number | null,
): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = selector(points[index]);
    if (value !== null && Number.isFinite(value)) return value;
  }
  return null;
}

function sampleCount(points: ContainerMetricHistoryPoint[]): number {
  return points.reduce((total, point) => total + point.sampleCount, 0);
}

function singleSeries(
  history: ContainerMetricHistorySeries | null,
  id: string,
  label: string,
  selector: (point: ContainerMetricHistoryPoint) => number | null,
  transform?: (value: number) => number,
) {
  if (!history) return [];
  return [
    {
      id,
      label,
      points: history.points.map((point) => {
        const value = selector(point);
        return {
          timestamp: point.timestamp,
          value: value === null ? null : transform ? transform(value) : value,
        };
      }),
    },
  ];
}

function dualSeries(
  history: ContainerMetricHistorySeries | null,
  first: {
    id: string;
    label: string;
    selector: (point: ContainerMetricHistoryPoint) => number | null;
  },
  second: {
    id: string;
    label: string;
    selector: (point: ContainerMetricHistoryPoint) => number | null;
  },
  transform?: (value: number) => number,
) {
  if (!history) return [];
  return [first, second].map((item) => ({
    id: item.id,
    label: item.label,
    points: history.points.map((point) => {
      const value = item.selector(point);
      return {
        timestamp: point.timestamp,
        value: value === null ? null : transform ? transform(value) : value,
      };
    }),
  }));
}

function historyHref(
  serverId: string,
  containerName: string,
  range: HistoryRange,
): string {
  return `/containers/${encodeURIComponent(serverId)}/${encodeURIComponent(containerName)}?range=${range}`;
}

function eventMarkers(events: MonitoringEvent[]): MetricChartMarker[] {
  return events.map((event) => ({
    id: String(event.id),
    timestamp: event.occurredAt,
    label: eventMarkerLabels[event.eventType],
    severity: event.severity,
  }));
}

export default async function ContainerDetailPage({ params, searchParams }: PageProps) {
  const [route, query] = await Promise.all([params, searchParams]);
  const { serverId, containerName } = route;
  if (!IDENTIFIER_PATTERN.test(serverId) || !IDENTIFIER_PATTERN.test(containerName)) {
    notFound();
  }

  const range = parseHistoryRange(firstValue(query.range));
  const rangeConfig = HISTORY_RANGE_CONFIG[range];

  let host: HostOverview | null = null;
  let container: ContainerOverview | null = null;
  let generatedAt = new Date().toISOString();
  let currentError = false;

  try {
    const snapshot = await getMonitoringSnapshot();
    generatedAt = snapshot.generatedAt;
    host = snapshot.hosts.find((item) => item.serverId === serverId) ?? null;
    if (!host) notFound();
    container =
      snapshot.containers.find(
        (item) => item.hostId === host?.id && item.name === containerName,
      ) ?? null;
    if (!container) notFound();
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    currentError = true;
    console.error("コンテナ現在値の取得に失敗しました", error);
  }

  let history: ContainerMetricHistorySeries | null = null;
  let events: MonitoringEvent[] = [];
  let historyError = false;
  let eventError = false;

  if (host) {
    const [historyResult, eventResult] = await Promise.allSettled([
      getContainerMetricHistory(range),
      getMonitoringEvents({ range, serverId, containerName }),
    ]);

    if (historyResult.status === "fulfilled") {
      history =
        historyResult.value.find(
          (item) => item.hostId === host?.id && item.containerName === containerName,
        ) ?? null;
    } else {
      historyError = true;
      console.error("コンテナ個別履歴の取得に失敗しました", historyResult.reason);
    }

    if (eventResult.status === "fulfilled") {
      events = eventResult.value;
    } else {
      eventError = true;
      console.error("コンテナ監視イベントの取得に失敗しました", eventResult.reason);
    }
  }

  const points = history?.points ?? [];
  const endAt = generatedAt;
  const startAt = new Date(
    Date.parse(endAt) - rangeConfig.hours * 3_600 * 1_000,
  ).toISOString();
  const expectedIntervalSeconds = history?.bucketSeconds ?? rangeConfig.bucketSeconds;
  const seriesLabel = container
    ? `${container.name} / ${container.hostDisplayName}`
    : containerName;
  const markers = eventMarkers(events);
  const peakCpu = peak(points, (point) => point.cpuPercent);
  const peakMemory = peak(points, (point) => point.memoryPercent);
  const peakPids = peak(points, (point) => point.pids);
  const latestRestart = latest(points, (point) => point.restartCount);
  const totalSamples = sampleCount(points);
  const historyDataSource =
    history?.dataSource ?? (range === "7d" || range === "30d" ? "rollup_5m" : "raw");

  return (
    <>
      <AutoRefresh intervalMs={rangeConfig.refreshMs} />
      <PageContent className={styles.containerContent}>
        <PageHeader
          actions={
            <>
              <ActionLink href="/containers">コンテナ一覧</ActionLink>
              <ActionLink href={`/history?range=${range}`}>全体履歴</ActionLink>
              <ActionLink
                href={`/events?range=${range}&target=${encodeURIComponent(`${serverId}/${containerName}`)}`}
              >
                全イベント
              </ActionLink>
            </>
          }
          description={`${host?.displayName ?? serverId}の現在値、履歴、状態変化を確認します。`}
          eyebrow="CONTAINER DETAIL"
          title={containerName}
        />

        {currentError ? (
          <StatePanel title="現在値を取得できませんでした" variant="error">
            監視データの取得経路を確認してください。
          </StatePanel>
        ) : container ? (
          <>
            <MetricGrid label="現在値サマリー">
              <MetricCard
                detail={`${stateLabels[container.state]} / ${healthLabels[container.health]}`}
                label="運用状態"
                value={
                  <StatusBadge tone={statusTone(container.status)}>
                    {statusLabels[container.status]}
                  </StatusBadge>
                }
              />
              <MetricCard
                detail="最新Snapshot"
                label="CPU / PIDs"
                value={
                  container.cpuPercent === null
                    ? "未取得"
                    : `${container.cpuPercent.toFixed(2)}% / ${container.pids ?? "—"}`
                }
              />
              <MetricCard
                detail={formatMemory(container)}
                label="Memory"
                value={`${memoryPercent(container)?.toFixed(2) ?? "—"}%`}
              />
              <MetricCard
                detail={formatDateTime(container.receivedAt)}
                label="最終受信"
                value={formatRelativeTime(container.receivedAt, generatedAt)}
              />
            </MetricGrid>

            <section className={styles.currentGrid} aria-label="コンテナ現在値詳細">
              <div><span>EXPECTED STATE</span><strong>{formatExpectedState(container.expectedState)}</strong></div>
              <div><span>STATE / HEALTH</span><strong>{stateLabels[container.state]} / {healthLabels[container.health]}</strong></div>
              <div><span>RESTART / EXIT</span><strong>{container.restartCount} / {formatExit(container)}</strong></div>
              <div><span>NETWORK RX / TX</span><strong>{formatBytes(container.networkRxBytes)} / {formatBytes(container.networkTxBytes)}</strong><small>Collector累積Counter</small></div>
              <div><span>BLOCK READ / WRITE</span><strong>{formatBytes(container.blockReadBytes)} / {formatBytes(container.blockWriteBytes)}</strong><small>Collector累積Counter</small></div>
              <div><span>OOM KILLED</span><strong>{container.oomKilled ? "検知" : "なし"}</strong></div>
            </section>

            {container.maintenanceMode ? (
              <StatePanel
                title={container.maintenanceActive ? "メンテナンス中" : "メンテナンス設定は期限切れ"}
                variant={container.maintenanceActive ? "info" : "warning"}
              >
                {container.maintenanceReason ?? "理由未設定"} / 期限 {formatDateTime(container.maintenanceUntil)}
              </StatePanel>
            ) : null}
          </>
        ) : null}

        <SectionHeader
          description="縦の破線は同じ期間に発生したState / Health / Restart / OOMなどの監視イベントです。"
          eyebrow="HISTORY"
          title="個別リソース履歴"
        />

        <nav className={styles.periodSelector} aria-label="表示期間">
          {(Object.keys(HISTORY_RANGE_CONFIG) as HistoryRange[]).map((item) => (
            <a
              aria-current={range === item ? "page" : undefined}
              className={range === item ? styles.active : undefined}
              href={historyHref(serverId, containerName, item)}
              key={item}
            >
              {HISTORY_RANGE_CONFIG[item].label}
            </a>
          ))}
        </nav>

        <MetricGrid label="選択期間の履歴サマリー">
          <MetricCard detail={rangeConfig.aggregationLabel} label="表示期間" value={rangeConfig.label} />
          <MetricCard detail="選択期間の最大値" label="Peak CPU" value={peakCpu === null ? "—" : `${peakCpu.toFixed(2)}%`} />
          <MetricCard detail="選択期間の最大値" label="Peak Memory" value={peakMemory === null ? "—" : `${peakMemory.toFixed(2)}%`} />
          <MetricCard detail="選択期間の最大値" label="Peak PIDs" value={peakPids === null ? "—" : Math.round(peakPids)} />
          <MetricCard detail="期間内の最新値" label="RestartCount" value={latestRestart === null ? "—" : Math.round(latestRestart)} />
          <MetricCard detail="同期間の状態変化" label="監視イベント" value={eventError ? "—" : events.length} />
          <MetricCard detail={dataSourceLabels[historyDataSource]} label="集約元Sample" value={historyError ? "—" : totalSamples.toLocaleString("ja-JP")} />
          <MetricCard detail={`${expectedIntervalSeconds}秒Bucket`} label="Data Source" value={dataSourceLabels[historyDataSource]} />
        </MetricGrid>

        {historyError ? (
          <StatePanel title="個別履歴を取得できませんでした" variant="error">
            履歴RPCの状態を確認してください。現在値・イベント表示には影響しません。
          </StatePanel>
        ) : (
          <div className={styles.chartGrid}>
            <MetricLineChart aggregationLabel={rangeConfig.aggregationLabel} description="Docker CPU使用率の推移です。" endAt={endAt} expectedIntervalSeconds={expectedIntervalSeconds} markers={markers} periodLabel={rangeConfig.label} series={singleSeries(history,"cpu",seriesLabel,(point)=>point.cpuPercent)} startAt={startAt} title="CPU使用率" unit="%" />
            <MetricLineChart aggregationLabel={rangeConfig.aggregationLabel} description="Container Memory Limitに対する使用率です。" endAt={endAt} expectedIntervalSeconds={expectedIntervalSeconds} markers={markers} maximum={100} periodLabel={rangeConfig.label} series={singleSeries(history,"memory",seriesLabel,(point)=>point.memoryPercent)} startAt={startAt} title="メモリ使用率" unit="%" />
            <MetricLineChart aggregationLabel={rangeConfig.aggregationLabel} description="コンテナ内のProcess数です。" endAt={endAt} expectedIntervalSeconds={expectedIntervalSeconds} markers={markers} periodLabel={rangeConfig.label} series={singleSeries(history,"pids",seriesLabel,(point)=>point.pids)} startAt={startAt} title="PIDs" unit="" valueDigits={0} />
            <MetricLineChart aggregationLabel={rangeConfig.aggregationLabel} description="Dockerが報告する累積RestartCountの推移です。" endAt={endAt} expectedIntervalSeconds={expectedIntervalSeconds} markers={markers} periodLabel={rangeConfig.label} series={singleSeries(history,"restart",seriesLabel,(point)=>point.restartCount)} startAt={startAt} title="RestartCount" unit="" valueDigits={0} />
            <MetricLineChart aggregationLabel={rangeConfig.aggregationLabel} description="Network累積Counterを区間差分へ変換した転送速度です。" endAt={endAt} expectedIntervalSeconds={expectedIntervalSeconds} markers={markers} periodLabel={rangeConfig.label} series={dualSeries(history,{id:"network-rx",label:"RX",selector:(point)=>point.networkRxRateBps},{id:"network-tx",label:"TX",selector:(point)=>point.networkTxRateBps},(value)=>value/1024)} startAt={startAt} title="Network I/O" unit=" KiB/s" />
            <MetricLineChart aggregationLabel={rangeConfig.aggregationLabel} description="Block I/O累積Counterを区間差分へ変換した速度です。" endAt={endAt} expectedIntervalSeconds={expectedIntervalSeconds} markers={markers} periodLabel={rangeConfig.label} series={dualSeries(history,{id:"block-read",label:"Read",selector:(point)=>point.blockReadRateBps},{id:"block-write",label:"Write",selector:(point)=>point.blockWriteRateBps},(value)=>value/1024)} startAt={startAt} title="Block I/O" unit=" KiB/s" />
          </div>
        )}

        <ContainerEventPanel
          containerName={containerName}
          error={eventError}
          events={events}
          range={range}
          serverId={serverId}
        />

        <StatePanel title="読み取り専用" variant="info">
          この画面は監視Snapshot・履歴RPC・構造化イベントだけを利用します。Docker操作、Shell、RCON、Secret、ログ本文は扱いません。
        </StatePanel>
      </PageContent>
    </>
  );
}