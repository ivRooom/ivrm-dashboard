import type { ReliabilitySnapshot } from "../../lib/reliability";
import styles from "./reliability.module.css";

const count = (value: number | null) => value === null ? "不明" : String(value);
const date = (value: string | null) => !value || !Number.isFinite(Date.parse(value)) ? "なし" : new Intl.DateTimeFormat("ja-JP", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(new Date(value));

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
        <div><span>ACTIVE SUPPRESSIONS</span><strong>{count(notification.activeSuppressionCount)}</strong></div>
        <div><span>LAST DELIVERY</span><strong>{date(notification.lastDeliveryAt)}</strong></div>
        <div><span>DISPATCHER SUCCESS</span><strong>{date(notification.dispatcherLastSuccessAt)}</strong></div>
      </div>
      {notification.lastErrorCode ? <div className={styles.coverage}>最新配送エラー: {notification.lastErrorCode}</div> : null}
    </section>
  );
}
