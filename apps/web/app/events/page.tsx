import { AutoRefresh } from "../../components/auto-refresh";
import {
  HISTORY_RANGE_CONFIG,
  parseHistoryRange,
  type HistoryRange,
} from "../../lib/history";
import { isValidHostServerId } from "../../lib/host-monitoring-events";
import {
  getMonitoringEvents,
  parseMonitoringEventSeverity,
  type MonitoringEvent,
  type MonitoringEventSeverity,
  type MonitoringEventSeverityFilter,
  type MonitoringEventType,
} from "../../lib/monitoring-events";
import { getMonitoringSnapshot } from "../../lib/monitoring";
import styles from "./events.module.css";

export const dynamic = "force-dynamic";

const CONTAINER_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const eventTypeLabels: Record<MonitoringEventType, string> = {
  state_changed: "State変化",
  health_changed: "Health変化",
  restart_count_increased: "RestartCount増加",
  oom_killed: "OOMKilled検知",
  exit_code_changed: "ExitCode変化",
  maintenance_started: "メンテナンス開始",
  maintenance_ended: "メンテナンス終了",
};

const severityLabels: Record<MonitoringEventSeverity, string> = {
  info: "情報",
  warning: "注意",
  critical: "重大",
  recovery: "復旧",
};

const expectedStateLabels = {
  running: "稼働期待",
  stopped: "停止期待",
  absent: "未作成期待",
} as const;

const markerClasses: Record<MonitoringEventSeverity, string> = {
  critical: styles.markerCritical,
  warning: styles.markerWarning,
  recovery: styles.markerRecovery,
  info: styles.markerInfo,
};

const severityClasses: Record<MonitoringEventSeverity, string> = {
  critical: styles.critical,
  warning: styles.warning,
  recovery: styles.recovery,
  info: styles.info,
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type EventTarget = {
  serverId: string;
  containerName: string;
};

type TargetOption = EventTarget & {
  hostDisplayName: string;
};

function firstValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function parseTarget(value: string | null): EventTarget | null {
  if (!value) {
    return null;
  }
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    return null;
  }
  const serverId = value.slice(0, separator);
  const containerName = value.slice(separator + 1);
  if (!isValidHostServerId(serverId) || !CONTAINER_IDENTIFIER_PATTERN.test(containerName)) {
    return null;
  }
  return { serverId, containerName };
}

function formatDateTime(timestamp: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Asia/Tokyo",
  }).format(new Date(timestamp));
}

function formatRelativeTime(timestamp: string, reference: string): string {
  const target = Date.parse(timestamp);
  const now = Date.parse(reference);
  if (!Number.isFinite(target) || !Number.isFinite(now)) {
    return "時刻不明";
  }
  const seconds = Math.max(0, Math.floor((now - target) / 1_000));
  if (seconds < 60) return `${seconds}秒前`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}時間前`;
  return `${Math.floor(seconds / 86_400)}日前`;
}

function transitionLabel(event: MonitoringEvent): string {
  if (event.eventType === "restart_count_increased") {
    const delta = event.numericValue ?? 0;
    return `${event.fromValue ?? "—"} → ${event.toValue ?? "—"}（+${delta}）`;
  }
  if (event.eventType === "oom_killed") {
    return "OOMKilled false → true";
  }
  if (event.eventType === "maintenance_started") {
    return "通常運用 → メンテナンス";
  }
  if (event.eventType === "maintenance_ended") {
    return "メンテナンス → 通常運用";
  }
  return `${event.fromValue ?? "—"} → ${event.toValue ?? "—"}`;
}

function severityCount(
  events: MonitoringEvent[],
  severity: MonitoringEventSeverity,
): number {
  return events.filter((event) => event.severity === severity).length;
}

export default async function EventsPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const range = parseHistoryRange(firstValue(query.range));
  const severity = parseMonitoringEventSeverity(firstValue(query.severity));
  const target = parseTarget(firstValue(query.target));
  const rangeConfig = HISTORY_RANGE_CONFIG[range];
  const generatedAt = new Date().toISOString();

  let events: MonitoringEvent[] = [];
  let eventError = false;
  try {
    events = await getMonitoringEvents({
      range,
      serverId: target?.serverId ?? null,
      containerName: target?.containerName ?? null,
      severity: severity === "all" ? null : severity,
    });
  } catch (error) {
    eventError = true;
    console.error("監視イベントの取得に失敗しました", error);
  }

  let targetOptions: TargetOption[] = [];
  try {
    const snapshot = await getMonitoringSnapshot();
    const hostById = new Map(snapshot.hosts.map((host) => [host.id, host]));
    targetOptions = snapshot.containers
      .flatMap((container): TargetOption[] => {
        const host = hostById.get(container.hostId);
        return host
          ? [
              {
                serverId: host.serverId,
                containerName: container.name,
                hostDisplayName: host.displayName,
              },
            ]
          : [];
      })
      .sort((left, right) =>
        `${left.hostDisplayName}:${left.containerName}`.localeCompare(
          `${right.hostDisplayName}:${right.containerName}`,
          "ja",
        ),
      );
  } catch (error) {
    console.error("イベントFilter用コンテナ一覧の取得に失敗しました", error);
  }

  const criticalCount = severityCount(events, "critical");
  const warningCount = severityCount(events, "warning");
  const recoveryCount = severityCount(events, "recovery");

  return (
    <>
      <AutoRefresh intervalMs={rangeConfig.refreshMs} />
      <section className={`content ${styles.eventsContent}`}>
        <header>
          <div>
            <p className={styles.eyebrow}>STRUCTURED EVENT TIMELINE</p>
            <h1>監視イベント</h1>
            <p>再起動、State / Health変化、OOM、復旧を生の構造化イベントとして時系列で追跡します。</p>
          </div>
          <div className={styles.headerActions}>
            <a className={styles.secondaryLink} href={`/incidents?range=${range}`}>
              Incident Center
            </a>
            <a className={styles.secondaryLink} href="/containers">
              コンテナ一覧
            </a>
            <a className={styles.secondaryLink} href={`/history?range=${range}`}>
              履歴グラフ
            </a>
          </div>
        </header>

        <section className={styles.summaryGrid} aria-label="イベントサマリー">
          <article>
            <span>イベント</span>
            <strong>{eventError ? "—" : events.length}</strong>
            <small>Keyset Pagination / {rangeConfig.label}</small>
          </article>
          <article>
            <span>重大</span>
            <strong>{eventError ? "—" : criticalCount}</strong>
            <small>OOM・Unhealthy・停止など</small>
          </article>
          <article>
            <span>注意</span>
            <strong>{eventError ? "—" : warningCount}</strong>
            <small>Restart・Startingなど</small>
          </article>
          <article>
            <span>復旧</span>
            <strong>{eventError ? "—" : recoveryCount}</strong>
            <small>Healthy / Runningへの復帰</small>
          </article>
        </section>

        <form className={styles.filters} method="get">
          <label>
            表示期間
            <select defaultValue={range} name="range">
              {(Object.keys(HISTORY_RANGE_CONFIG) as HistoryRange[]).map((item) => (
                <option key={item} value={item}>
                  {HISTORY_RANGE_CONFIG[item].label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Severity
            <select defaultValue={severity} name="severity">
              <option value="all">すべて</option>
              {(["critical", "warning", "recovery", "info"] as MonitoringEventSeverity[]).map(
                (item) => (
                  <option key={item} value={item}>
                    {severityLabels[item]}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            コンテナ
            <select
              defaultValue={target ? `${target.serverId}/${target.containerName}` : "all"}
              name="target"
            >
              <option value="all">すべてのコンテナ</option>
              {targetOptions.map((item) => (
                <option
                  key={`${item.serverId}:${item.containerName}`}
                  value={`${item.serverId}/${item.containerName}`}
                >
                  {item.containerName} / {item.hostDisplayName}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">絞り込む</button>
        </form>

        {eventError ? (
          <div className="empty error-panel" role="alert">
            <strong>監視イベントを取得できませんでした</strong>
            <p>イベントRPCとSupabase接続を確認してください。既存の現在値・履歴監視には影響しません。</p>
          </div>
        ) : events.length === 0 ? (
          <div className="empty">
            <strong>選択条件に一致するイベントはありません</strong>
            <p>状態変化が発生すると、自動的にこのタイムラインへ追加されます。</p>
          </div>
        ) : (
          <section className={styles.timeline} aria-label="監視イベントタイムライン">
            {events.map((event) => (
              <article className={styles.event} key={event.id}>
                <i
                  aria-hidden="true"
                  className={`${styles.marker} ${markerClasses[event.severity]}`}
                />
                <div className={styles.eventMain}>
                  <div className={styles.eventHeading}>
                    <h3>{eventTypeLabels[event.eventType]}</h3>
                    <span className={`${styles.badge} ${severityClasses[event.severity]}`}>
                      {severityLabels[event.severity]}
                    </span>
                  </div>
                  <p className={styles.meta}>
                    {event.containerName} / {event.hostDisplayName} ({event.serverId})
                  </p>
                  <p className={styles.transition}>
                    <strong>{transitionLabel(event)}</strong>
                  </p>
                  <p className={styles.expected}>
                    期待状態: {event.expectedState ? expectedStateLabels[event.expectedState] : "未設定"}
                  </p>
                </div>
                <div className={styles.eventAside}>
                  <time dateTime={event.occurredAt}>{formatRelativeTime(event.occurredAt, generatedAt)}</time>
                  <small>{formatDateTime(event.occurredAt)}</small>
                  <a
                    href={`/containers/${encodeURIComponent(event.serverId)}/${encodeURIComponent(event.containerName)}?range=${range}`}
                  >
                    詳細を見る
                  </a>
                </div>
              </article>
            ))}
          </section>
        )}

        <section className={styles.notice}>
          <strong>構造化イベントのみ保存</strong>
          <p>
            イベントにはState、Health、RestartCount、ExitCode、OOM、Maintenanceの差分だけを保存します。ログ本文、IP、Token、Secret、Docker操作コマンドは保存しません。Incident Centerはこの構造化イベントと現在Snapshotだけを使って障害を要約します。
          </p>
        </section>
      </section>
    </>
  );
}
