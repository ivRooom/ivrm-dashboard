import { notFound } from "next/navigation";
import { AutoRefresh } from "../../../components/auto-refresh";
import {
  MetricLineChart,
  type MetricChartMarker,
} from "../../../components/metric-line-chart";
import {
  getHostMonitoringEvents,
  isValidHostServerId,
  type HostMonitoringEvent,
} from "../../../lib/host-monitoring-events";
import {
  HISTORY_RANGE_CONFIG,
  getHostMetricHistory,
  parseHistoryRange,
  type HistoryDataSource,
  type HistoryRange,
  type HostMetricHistoryPoint,
  type HostMetricHistorySeries,
} from "../../../lib/history";
import {
  getMonitoringSnapshot,
  type ContainerOverview,
  type HostOverview,
} from "../../../lib/monitoring";
import styles from "../hosts.module.css";

export const dynamic = "force-dynamic";

const statusLabels = { online: "稼働中", stale: "更新遅延", offline: "受信停止" } as const;
const containerStatusLabels = {
  online: "稼働中",
  offline: "受信停止",
  stale: "更新遅延",
  error: "異常",
  standby: "待機中",
  maintenance: "メンテナンス",
} as const;
const dataSourceLabels: Record<HistoryDataSource, string> = {
  raw: "生データ",
  rollup_5m: "5分ロールアップ",
};
const eventLabels: Record<HostMonitoringEvent["eventType"], string> = {
  host_reboot_detected: "Host再起動を検知",
  agent_version_changed: "Agent Version変更",
  heartbeat_gap_detected: "Heartbeat gapを検知",
};

type PageProps = {
  params: Promise<{ serverId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function percent(total: number | null, available: number | null): number | null {
  if (total === null || available === null || total <= 0) return null;
  return Math.min(100, Math.max(0, ((total - available) / total) * 100));
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "未取得";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 1 : 2)} ${units[unit]}`;
}

function formatCapacity(total: number | null, available: number | null): string {
  const usage = percent(total, available);
  if (usage === null || total === null || available === null) return "未取得";
  return `${formatBytes(Math.max(0, total - available))} / ${formatBytes(total)} (${usage.toFixed(1)}%)`;
}

function formatDateTime(timestamp: string | null): string {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "未設定";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Asia/Tokyo",
  }).format(new Date(timestamp));
}

function formatRelativeTime(timestamp: string | null, reference: string): string {
  if (!timestamp) return "未受信";
  const target = Date.parse(timestamp);
  const now = Date.parse(reference);
  if (!Number.isFinite(target) || !Number.isFinite(now)) return "時刻不明";
  const age = Math.max(0, Math.floor((now - target) / 1_000));
  if (age < 60) return `${age}秒前`;
  if (age < 3_600) return `${Math.floor(age / 60)}分前`;
  if (age < 86_400) return `${Math.floor(age / 3_600)}時間前`;
  return `${Math.floor(age / 86_400)}日前`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (days > 0) return `${days}日 ${hours}時間`;
  if (hours > 0) return `${hours}時間 ${minutes}分`;
  if (minutes > 0) return `${minutes}分 ${rest}秒`;
  return `${rest}秒`;
}

function loadText(host: HostOverview): string {
  if (host.loadAverage1 === null || host.loadAverage5 === null || host.loadAverage15 === null) return "未取得";
  return `${host.loadAverage1.toFixed(2)} / ${host.loadAverage5.toFixed(2)} / ${host.loadAverage15.toFixed(2)}`;
}

function peak(points: HostMetricHistoryPoint[], selector: (point: HostMetricHistoryPoint) => number | null): number | null {
  const values = points.map(selector).filter((value): value is number => value !== null && Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

function sampleCount(points: HostMetricHistoryPoint[]): number {
  return points.reduce((total, point) => total + point.sampleCount, 0);
}

function hostMarkers(events: HostMonitoringEvent[]): MetricChartMarker[] {
  return events.map((event) => ({
    id: `host-event-${event.id}`,
    timestamp: event.occurredAt,
    label: eventLabels[event.eventType],
    severity: event.severity,
  }));
}

function eventDetail(event: HostMonitoringEvent): string {
  switch (event.eventType) {
    case "agent_version_changed":
      return `${event.fromValue ?? "不明"} → ${event.toValue ?? "不明"}`;
    case "heartbeat_gap_detected":
      return `Heartbeat間隔 ${formatDuration(event.numericValue)}`;
    case "host_reboot_detected":
      return `Uptime ${formatDuration(event.fromValue ? Number(event.fromValue) : null)} → ${formatDuration(event.toValue ? Number(event.toValue) : null)}`;
  }
}

function historyHref(serverId: string, range: HistoryRange): string {
  return `/hosts/${encodeURIComponent(serverId)}?range=${range}`;
}

function hostLoadSeries(history: HostMetricHistorySeries | null) {
  if (!history) return [];
  const selectors = [
    { id: "load1", label: "Load 1m", get: (point: HostMetricHistoryPoint) => point.loadAverage1 },
    { id: "load5", label: "Load 5m", get: (point: HostMetricHistoryPoint) => point.loadAverage5 },
    { id: "load15", label: "Load 15m", get: (point: HostMetricHistoryPoint) => point.loadAverage15 },
  ];
  return selectors.map((item) => ({
    id: item.id,
    label: item.label,
    points: history.points.map((point) => ({ timestamp: point.timestamp, value: item.get(point) })),
  }));
}

function singleSeries(history: HostMetricHistorySeries | null, id: string, label: string, selector: (point: HostMetricHistoryPoint) => number | null) {
  if (!history) return [];
  return [{
    id,
    label,
    points: history.points.map((point) => ({ timestamp: point.timestamp, value: selector(point) })),
  }];
}

export default async function HostDetailPage({ params, searchParams }: PageProps) {
  const [route, query] = await Promise.all([params, searchParams]);
  const serverId = route.serverId;
  if (!isValidHostServerId(serverId)) notFound();

  const range = parseHistoryRange(firstValue(query.range));
  const rangeConfig = HISTORY_RANGE_CONFIG[range];

  let host: HostOverview | null = null;
  let containers: ContainerOverview[] = [];
  let generatedAt = new Date().toISOString();
  let currentError = false;

  try {
    const snapshot = await getMonitoringSnapshot();
    generatedAt = snapshot.generatedAt;
    host = snapshot.hosts.find((item) => item.serverId === serverId) ?? null;
    if (!host) notFound();
    containers = snapshot.containers.filter((container) => container.hostId === host?.id);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    currentError = true;
    console.error("Host現在値の取得に失敗しました", error);
  }

  let history: HostMetricHistorySeries | null = null;
  let historyError = false;
  if (host) {
    try {
      const allHistory = await getHostMetricHistory(range);
      history = allHistory.find((item) => item.hostId === host?.id) ?? null;
    } catch (error) {
      historyError = true;
      console.error("Host個別履歴の取得に失敗しました", error);
    }
  }

  let events: HostMonitoringEvent[] = [];
  let eventError = false;
  try {
    events = await getHostMonitoringEvents(range, serverId);
  } catch (error) {
    eventError = true;
    console.error("Host監視イベントの取得に失敗しました", error);
  }

  const points = history?.points ?? [];
  const endAt = new Date().toISOString();
  const startAt = new Date(Date.parse(endAt) - rangeConfig.hours * 3_600_000).toISOString();
  const markers = hostMarkers(events);
  const source = history?.dataSource ?? (range === "7d" || range === "30d" ? "rollup_5m" : "raw");
  const bucket = history?.bucketSeconds ?? rangeConfig.bucketSeconds;
  const peakLoad = peak(points, (point) => point.loadAverage1);
  const peakMemory = peak(points, (point) => point.memoryPercent);
  const peakDisk = peak(points, (point) => point.diskPercent);
  const samples = sampleCount(points);
  const problemContainers = containers.filter((container) => ["error", "offline", "stale"].includes(container.status));

  const sharedChartProps = {
    startAt,
    endAt,
    expectedIntervalSeconds: bucket,
    aggregationLabel: rangeConfig.aggregationLabel,
    periodLabel: rangeConfig.label,
    markers,
  } as const;

  return (
    <main className="shell">
      <AutoRefresh intervalMs={rangeConfig.refreshMs} />
      <aside className="sidebar">
        <a className="brand" href="/#top"><span>IV</span><strong>IVRM Console</strong></a>
        <nav aria-label="メインナビゲーション">
          <a href="/#top">概要</a>
          <a href="/minecraft">Minecraft</a>
          <a aria-current="page" href="/hosts">ホスト</a>
          <a href="/containers">コンテナ</a>
          <a href={`/history?range=${range}`}>履歴グラフ</a>
          <a href="/events">コンテナイベント</a>
        </nav>
        <div className="agent">
          <i className={currentError ? "error" : host?.status ?? "offline"} />
          {serverId}<br />
          <small>{currentError ? "取得エラー" : host ? statusLabels[host.status] : "未受信"}</small>
        </div>
      </aside>

      <section className={`content ${styles.hostContent}`}>
        <header>
          <div>
            <p className={styles.eyebrow}>HOST DETAIL</p>
            <h1>{host?.displayName ?? serverId}</h1>
            <p>Host自体の現在値・履歴・Heartbeatイベントと、配下Containerをまとめて確認します。</p>
          </div>
          <div className={styles.headerActions}>
            <a className={styles.secondaryLink} href="/hosts">ホスト一覧</a>
            <a className={styles.secondaryLink} href={`/history?range=${range}`}>全体履歴</a>
          </div>
        </header>

        {currentError ? (
          <div className="empty error-panel" role="alert" style={{ marginTop: 28 }}><strong>Host現在値を取得できませんでした</strong><p>監視データ取得経路を確認してください。</p></div>
        ) : host ? (
          <>
            <section className={styles.summaryGrid} aria-label="Host現在値サマリー">
              <article><span>運用状態</span><strong>{statusLabels[host.status]}</strong><small>{host.provider.toUpperCase()} / {host.environment}</small></article>
              <article><span>Agent</span><strong>{host.agentVersion ?? "未受信"}</strong><small>{formatRelativeTime(host.receivedAt, generatedAt)}</small></article>
              <article><span>Uptime</span><strong>{formatDuration(host.uptimeSeconds === null ? null : Math.floor(host.uptimeSeconds))}</strong><small>OS uptime</small></article>
              <article><span>配下Container</span><strong>{containers.length}</strong><small>{problemContainers.length > 0 ? `${problemContainers.length}件 要確認` : "要確認なし"}</small></article>
            </section>

            <section className={styles.currentGrid} aria-label="Host現在値詳細">
              <div><span>SERVER ID</span><strong>{host.serverId}</strong><small>{host.provider.toUpperCase()} / {host.environment}</small></div>
              <div><span>CPU / LOAD 1·5·15</span><strong>{host.cpuCount ?? "—"} vCPU</strong><small>{loadText(host)}</small></div>
              <div><span>MEMORY</span><strong>{percent(host.memoryTotalBytes, host.memoryAvailableBytes)?.toFixed(1) ?? "—"}%</strong><small>{formatCapacity(host.memoryTotalBytes, host.memoryAvailableBytes)}</small></div>
              <div><span>DISK</span><strong>{percent(host.diskTotalBytes, host.diskAvailableBytes)?.toFixed(1) ?? "—"}%</strong><small>{formatCapacity(host.diskTotalBytes, host.diskAvailableBytes)}</small></div>
              <div><span>LAST HEARTBEAT</span><strong>{formatRelativeTime(host.receivedAt, generatedAt)}</strong><small>{formatDateTime(host.receivedAt)}</small></div>
              <div><span>SENT AT</span><strong>{formatDateTime(host.sentAt)}</strong><small>Agent送信時刻</small></div>
            </section>
          </>
        ) : null}

        <div className={styles.sectionHeading}>
          <div><span>HISTORY</span><h2>Hostリソース履歴</h2></div>
          <p>Load Average・Memory・Diskを同一Hostに絞り、Hostイベントを縦マーカーで重ねます。</p>
        </div>

        <nav className={styles.periodSelector} aria-label="表示期間">
          {(Object.keys(HISTORY_RANGE_CONFIG) as HistoryRange[]).map((candidate) => (
            <a key={candidate} aria-current={candidate === range ? "page" : undefined} className={candidate === range ? styles.active : undefined} href={historyHref(serverId, candidate)}>{HISTORY_RANGE_CONFIG[candidate].label}</a>
          ))}
        </nav>

        <section className={styles.summaryGrid} aria-label="選択期間のHost履歴サマリー">
          <div><span>表示期間</span><strong>{rangeConfig.label}</strong><small>{rangeConfig.aggregationLabel}</small></div>
          <div><span>Peak Load 1m</span><strong>{peakLoad === null ? "—" : peakLoad.toFixed(2)}</strong><small>選択期間最大値</small></div>
          <div><span>Peak Memory</span><strong>{peakMemory === null ? "—" : `${peakMemory.toFixed(1)}%`}</strong><small>選択期間最大値</small></div>
          <div><span>Peak Disk</span><strong>{peakDisk === null ? "—" : `${peakDisk.toFixed(1)}%`}</strong><small>選択期間最大値</small></div>
          <div><span>Hostイベント</span><strong>{eventError ? "—" : events.length}</strong><small>同期間</small></div>
          <div><span>集約元Sample</span><strong>{historyError ? "—" : samples.toLocaleString("ja-JP")}</strong><small>{dataSourceLabels[source]}</small></div>
          <div><span>Bucket</span><strong>{rangeConfig.aggregationLabel}</strong><small>{bucket}秒</small></div>
          <div><span>Data Source</span><strong>{dataSourceLabels[source]}</strong><small>既存履歴RPC</small></div>
        </section>

        {historyError ? (
          <div className="empty error-panel" role="alert"><strong>Host履歴を取得できませんでした</strong><p>現在値とHostイベントの表示には影響しません。</p></div>
        ) : (
          <div className={styles.chartGrid}>
            <MetricLineChart {...sharedChartProps} title="Load Average" description="1分・5分・15分の実行待ち負荷です。" series={hostLoadSeries(history)} unit="" />
            <MetricLineChart {...sharedChartProps} title="Host Memory" description="総メモリとAvailableから算出した使用率です。" series={singleSeries(history, "memory", host?.displayName ?? serverId, (point) => point.memoryPercent)} unit="%" maximum={100} />
            <MetricLineChart {...sharedChartProps} title="Disk使用率" description="監視対象ファイルシステムの使用率です。" series={singleSeries(history, "disk", host?.displayName ?? serverId, (point) => point.diskPercent)} unit="%" maximum={100} />
          </div>
        )}

        <div className={styles.sectionHeading}>
          <div><span>HOST EVENTS</span><h2>Hostイベント</h2></div>
          <p>OS Uptime低下、Agent Version変更、45秒を超えるHeartbeat gapを記録します。</p>
        </div>

        {eventError ? (
          <div className="empty error-panel" role="alert"><strong>Hostイベントを取得できませんでした</strong><p>リソース履歴の表示には影響しません。</p></div>
        ) : events.length === 0 ? (
          <div className={styles.emptyState}>選択期間にHostイベントはありません。</div>
        ) : (
          <div className={styles.eventList}>
            {events.slice(0, 20).map((event) => (
              <article className={`${styles.eventItem} ${event.severity === "warning" ? styles.eventWarning : styles.eventInfo}`} key={event.id}>
                <div><strong className={styles.eventType}>{eventLabels[event.eventType]}</strong><small>{event.severity.toUpperCase()}</small></div>
                <div><strong>{formatDateTime(event.occurredAt)}</strong><small>{formatRelativeTime(event.occurredAt, generatedAt)}</small></div>
                <div><strong>{eventDetail(event)}</strong><small>{event.eventType}</small></div>
                <div><strong>{event.numericValue === null ? "—" : formatDuration(event.numericValue)}</strong><small>numeric detail</small></div>
              </article>
            ))}
          </div>
        )}

        <div className={styles.sectionHeading}>
          <div><span>CONTAINERS</span><h2>配下コンテナ</h2></div>
          <p>Host負荷とContainer負荷を往復して障害原因を切り分けます。</p>
        </div>

        {containers.length === 0 ? (
          <div className={styles.emptyState}>このHostからContainer Snapshotはまだ届いていません。</div>
        ) : (
          <div className={styles.containerList}>
            {containers.map((container) => (
              <article className={styles.containerItem} key={container.name}>
                <div><strong><a className={styles.detailLink} href={`/containers/${encodeURIComponent(serverId)}/${encodeURIComponent(container.name)}`}>{container.name}</a></strong><small>{containerStatusLabels[container.status]}</small></div>
                <div><strong>{container.cpuPercent === null ? "—" : `${container.cpuPercent.toFixed(2)}%`}</strong><small>CPU</small></div>
                <div><strong>{container.memoryUsageBytes === null ? "—" : formatBytes(container.memoryUsageBytes)}</strong><small>Memory / PIDs {container.pids ?? "—"}</small></div>
                <div><strong>Restart {container.restartCount}</strong><small>{formatRelativeTime(container.receivedAt, generatedAt)}</small></div>
              </article>
            ))}
          </div>
        )}

        <section className={styles.notice}><strong>読み取り専用</strong><p>Host詳細はHeartbeat・既存履歴RPC・構造化Hostイベントだけを利用します。Shell、Docker操作、RCON、Secret、IP、ログ本文は扱いません。</p></section>
      </section>
    </main>
  );
}
