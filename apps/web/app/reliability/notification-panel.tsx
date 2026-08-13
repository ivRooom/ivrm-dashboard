import type { ReliabilitySnapshot } from "../../lib/reliability";
import styles from "./reliability.module.css";

function date(timestamp: string | null): string {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "なし";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(timestamp));
}

function count(value: number | null): string {
  return value === null ? "不明" : String(value);
}

export function ReliabilityNotificationPanel({ data }: { data: ReliabilitySnapshot }) {
  const notification = data.notifications;
  return (
    <section className={styles.delivery}>
      <div className={styles.sectionTitle}>
        <div><span>DELIVERY PIPELINE</span><h2>Notification Delivery</h2></div>
        <p>Channelを意図的にOFFにしている場合は障害ではなく「停止中」として扱います。</p>
      </div>
      <div className={styles.deliveryGrid}>
        <div><span>CHANNEL</span><strong>{notification.enabled === null ? "不明" : notification.enabled ? "Enabled" : "Disabled"}</strong></div>
        <div><span>CONFIGURED</span><strong>{notification.configured === null ? "不明" : notification.configured ? "Ready" : "Not Ready"}</strong></div>
        <div><span>PENDING / RETRY</span><strong>{count(notification.pendingCount)} / {count(notification.retryCount)}</strong></div>
        <div><span>FAILED</span><strong>{count(notification.failedCount)}</strong></div>
        <div><span>SENT 24H</span><strong>{count(notification.sent24hCount)}</strong></div>
        <div><span>SUPPRESSED</span><strong>{count(notification.suppressedCount)}</strong></div>
        <div><span>LAST DELIVERY</span><strong>{date(notification.lastDeliveryAt)}</strong></div>
        <div><span>DISPATCHER SUCCESS</span><strong>{date(notification.dispatcherLastSuccessAt)}</strong></div>
      </div>
      {notification.lastErrorCode ? (
        <div className={styles.coverage}>最新配送エラー: {notification.lastErrorCode}</div>
      ) : null}
    </section>
  );
}
