import { AutoRefresh } from "../../components/auto-refresh";
import {
  getHostMonitoringEvents,
  type HostMonitoringEvent,
} from "../../lib/host-monitoring-events";
import {
  getMonitoringSnapshot,
  type ContainerOverview,
  type HostOverview,
} from "../../lib/monitoring";
import styles from "./hosts.module.css";

export const dynamic = "force-dynamic";

const statusLabels = {
  online: "稼働中",
  stale: "更新遅延",
  offline: "受信停止",
} as const;

const eventLabels: Record<HostMonitoringEvent["eventType"], string> = {
  host_reboot_detected: "Host再起動",
  agent_version_changed: "Agent更新",
  heartbeat_gap_detected: "Heartbeat gap",
};

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

function formatLoad(host: HostOverview): string {
  if (host.loadAverage1 === null || host.loadAverage5 === null || host.loadAverage15 === null) {
    return "未取得";
  }
  return `${host.loadAverage1.toFixed(2)} / ${host.loadAverage5.toFixed(2)} / ${host.loadAverage15.toFixed(2)}`;
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return "未取得";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days > 0 ? `${days}日 ${hours}時間` : `${hours}時間 ${minutes}分`;
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

function containersForHost(containers: ContainerOverview[], hostId: string) {
  return containers.filter((container) => container.hostId === hostId);
}

function issueCount(containers: ContainerOverview[]): number {
  return containers.filter((container) => ["error", "offline", "stale"].includes(container.status)).length;
}

export default async function HostsPage() {
  let hosts: HostOverview[] = [];
  let containers: ContainerOverview[] = [];
  let generatedAt = new Date().toISOString();
  let dataError = false;

  try {
    const snapshot = await getMonitoringSnapshot();
    hosts = snapshot.hosts;
    containers = snapshot.containers;
    generatedAt = snapshot.generatedAt;
  } catch (error) {
    dataError = true;
    console.error("ホスト一覧の監視Snapshot取得に失敗しました", error);
  }

  let hostEvents: HostMonitoringEvent[] = [];
  let eventError = false;
  try {
    hostEvents = await getHostMonitoringEvents("30d");
  } catch (error) {
    eventError = true;
    console.error("ホスト監視イベントの取得に失敗しました", error);
  }

  const online = hosts.filter((host) => host.status === "online").length;
  const delayed = hosts.filter((host) => host.status === "stale").length;
  const offline = hosts.filter((host) => host.status === "offline").length;
  const warningEvents = hostEvents.filter((event) => event.severity === "warning").length;
  const latestEventByHost = new Map<string, HostMonitoringEvent>();
  for (const event of hostEvents) {
    if (!latestEventByHost.has(event.hostId)) latestEventByHost.set(event.hostId, event);
  }

  return (
    <>
      <AutoRefresh />
      <section className={`content ${styles.hostContent}`}>
        <header>
          <div>
            <p className={styles.eyebrow}>HOSTS</p>
            <h1>ホスト監視</h1>
            <p>Agent、OSリソース、配下コンテナ、Hostイベントをホスト単位で確認します。</p>
          </div>
          <div className={styles.headerActions}>
            <a className={styles.secondaryLink} href="/history">全体履歴</a>
            <a className={styles.secondaryLink} href="/events">コンテナイベント</a>
          </div>
        </header>

        <section className={styles.summaryGrid} aria-label="ホスト監視サマリー">
          <article><span>監視ホスト</span><strong>{dataError ? "—" : hosts.length}</strong><small>有効Host登録数</small></article>
          <article><span>正常</span><strong>{dataError ? "—" : online}</strong><small>Heartbeat 45秒以内</small></article>
          <article><span>遅延 / 停止</span><strong>{dataError ? "—" : `${delayed} / ${offline}`}</strong><small>45秒超 / 180秒超</small></article>
          <article><span>Host警告イベント</span><strong>{eventError ? "—" : warningEvents}</strong><small>直近30日</small></article>
        </section>

        {dataError ? (
          <div className="empty error-panel" role="alert">
            <strong>ホスト監視データを取得できませんでした</strong>
            <p>Supabase接続と監視データ取得経路を確認してください。</p>
          </div>
        ) : hosts.length === 0 ? (
          <div className={styles.emptyState}>監視対象Hostが登録されるとここへ表示されます。</div>
        ) : (
          <div className={styles.hostGrid}>
            {hosts.map((host) => {
              const hostContainers = containersForHost(containers, host.id);
              const problems = issueCount(hostContainers);
              const latestEvent = latestEventByHost.get(host.id) ?? null;
              return (
                <article className={styles.hostCard} key={host.id}>
                  <div className={styles.cardTop}>
                    <div className={styles.identity}>
                      <h2><a className={styles.detailLink} href={`/hosts/${encodeURIComponent(host.serverId)}`}>{host.displayName}</a></h2>
                      <p>{host.serverId} / {host.provider.toUpperCase()} / {host.environment}</p>
                    </div>
                    <span className={`status ${host.status}`}>{statusLabels[host.status]}</span>
                  </div>

                  <div className={styles.metaGrid}>
                    <div><span>AGENT</span><strong>{host.agentVersion ?? "未受信"}</strong><small>{formatRelativeTime(host.receivedAt, generatedAt)}</small></div>
                    <div><span>CPU / LOAD 1·5·15</span><strong>{host.cpuCount ?? "—"} vCPU</strong><small>{formatLoad(host)}</small></div>
                    <div><span>UPTIME</span><strong>{formatUptime(host.uptimeSeconds)}</strong><small>OS uptime</small></div>
                    <div><span>MEMORY</span><strong>{percent(host.memoryTotalBytes, host.memoryAvailableBytes)?.toFixed(1) ?? "—"}%</strong><small>{formatCapacity(host.memoryTotalBytes, host.memoryAvailableBytes)}</small></div>
                    <div><span>DISK</span><strong>{percent(host.diskTotalBytes, host.diskAvailableBytes)?.toFixed(1) ?? "—"}%</strong><small>{formatCapacity(host.diskTotalBytes, host.diskAvailableBytes)}</small></div>
                    <div><span>CONTAINERS</span><strong>{hostContainers.length}</strong><small>{problems > 0 ? `${problems}件 要確認` : "要確認なし"}</small></div>
                  </div>

                  <div className={styles.currentGrid}>
                    <div><span>最新Hostイベント</span><strong>{latestEvent ? eventLabels[latestEvent.eventType] : "なし"}</strong><small>{latestEvent ? formatRelativeTime(latestEvent.occurredAt, generatedAt) : "直近30日"}</small></div>
                    <div><span>最終Heartbeat</span><strong>{formatRelativeTime(host.receivedAt, generatedAt)}</strong><small>{host.receivedAt ?? "未受信"}</small></div>
                    <div><span>詳細</span><strong><a className={styles.detailLink} href={`/hosts/${encodeURIComponent(host.serverId)}`}>Host詳細を開く →</a></strong><small>現在値・履歴・イベント</small></div>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {eventError ? (
          <section className={styles.notice}>
            <strong>Hostイベントのみ取得できませんでした</strong>
            <p>現在値の表示には影響しません。<code>get_host_monitoring_events_v2</code>の状態を確認してください。</p>
          </section>
        ) : null}
      </section>
    </>
  );
}
