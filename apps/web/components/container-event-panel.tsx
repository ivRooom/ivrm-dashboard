import type { HistoryRange } from "../lib/history";
import type {
  MonitoringEvent,
  MonitoringEventSeverity,
  MonitoringEventType,
} from "../lib/monitoring-events";
import styles from "./container-event-panel.module.css";

const eventLabels: Record<MonitoringEventType, string> = {
  state_changed: "State変化",
  health_changed: "Health変化",
  restart_count_increased: "RestartCount増加",
  oom_killed: "OOMKilled",
  exit_code_changed: "ExitCode変化",
  maintenance_started: "Maintenance開始",
  maintenance_ended: "Maintenance終了",
};

const severityLabels: Record<MonitoringEventSeverity, string> = {
  info: "情報",
  warning: "注意",
  critical: "重大",
  recovery: "復旧",
};

const severityClasses: Record<MonitoringEventSeverity, string> = {
  info: styles.info,
  warning: styles.warning,
  critical: styles.critical,
  recovery: styles.recovery,
};

function formatDateTime(timestamp: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo",
  }).format(new Date(timestamp));
}

function transition(event: MonitoringEvent): string {
  if (event.eventType === "restart_count_increased") {
    return `${event.fromValue ?? "—"} → ${event.toValue ?? "—"} (+${event.numericValue ?? 0})`;
  }
  if (event.eventType === "maintenance_started") {
    return "通常運用 → メンテナンス";
  }
  if (event.eventType === "maintenance_ended") {
    return "メンテナンス → 通常運用";
  }
  return `${event.fromValue ?? "—"} → ${event.toValue ?? "—"}`;
}

export function ContainerEventPanel({
  events,
  range,
  serverId,
  containerName,
  error = false,
}: {
  events: MonitoringEvent[];
  range: HistoryRange;
  serverId: string;
  containerName: string;
  error?: boolean;
}) {
  return (
    <section className={styles.panel} aria-label="関連監視イベント">
      <div className={styles.header}>
        <div>
          <strong>関連イベント</strong>
          <p>選択中の履歴期間と同じ範囲のState / Health / Restart / OOMを表示します。</p>
        </div>
        <a
          href={`/events?range=${range}&target=${encodeURIComponent(`${serverId}/${containerName}`)}`}
        >
          全イベントを見る
        </a>
      </div>

      {error ? (
        <p className={styles.empty}>イベントを取得できませんでした。リソース履歴の表示には影響しません。</p>
      ) : events.length === 0 ? (
        <p className={styles.empty}>この期間に記録された状態変化はありません。</p>
      ) : (
        <div className={styles.list}>
          {events.slice(0, 12).map((event) => (
            <article className={styles.event} key={event.id}>
              <span className={`${styles.badge} ${severityClasses[event.severity]}`}>
                {severityLabels[event.severity]}
              </span>
              <div>
                <strong>{eventLabels[event.eventType]}</strong>
                <small>{transition(event)}</small>
              </div>
              <time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
