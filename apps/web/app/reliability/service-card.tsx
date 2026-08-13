import type { ReliabilityRange, ReliabilityService } from "../../lib/reliability";
import styles from "./reliability.module.css";

const healthLabels = {
  operational: "正常",
  degraded: "低下",
  critical: "重大",
  disabled: "停止中",
  unknown: "不明",
} as const;

function duration(seconds: number | null): string {
  if (seconds === null) return "対象外";
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes ? `${hours}時間 ${minutes}分` : `${hours}時間`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return hours ? `${days}日 ${hours}時間` : `${days}日`;
}

function ratio(value: number | null, exact: boolean): string {
  if (value === null) return "対象外";
  const text = `${(value * 100).toFixed(value >= 0.999 ? 3 : 2)}%`;
  return exact ? text : `≤ ${text}`;
}

function date(timestamp: string | null): string {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "なし";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(timestamp));
}

type Props = { service: ReliabilityService; range: ReliabilityRange };

export function ReliabilityServiceCard({ service, range }: Props) {
  const notification = service.id === "notifications";
  return (
    <article className={styles.serviceCard}>
      <div className={styles.serviceHead}>
        <div><span>{service.id.toUpperCase()}</span><h3>{service.label}</h3><p>{service.description}</p></div>
        <strong className={`${styles.badge} ${styles[service.health]}`}>{healthLabels[service.health]}</strong>
      </div>
      <div className={styles.serviceMetrics}>
        <div><span>INCIDENT-FREE</span><strong>{ratio(service.incidentFreeRatio, service.exactCoverage)}</strong></div>
        <div><span>KNOWN DOWNTIME</span><strong>{duration(service.knownDowntimeSeconds)}</strong></div>
        <div><span>{notification ? "ACTIVE SIGNALS" : "ACTIVE"}</span><strong>{service.activeIncidentCount}</strong></div>
        <div><span>{notification ? "SENT 24H" : "RECOVERED"}</span><strong>{service.recoveredIncidentCount}</strong></div>
        <div><span>AFFECTED</span><strong>{service.affectedEntityCount}</strong></div>
        <div><span>MEDIAN RECOVERY</span><strong>{duration(service.medianRecoverySeconds)}</strong></div>
        <div><span>LONGEST RECOVERY</span><strong>{duration(service.longestRecoverySeconds)}</strong></div>
        <div><span>{notification ? "LAST DELIVERY" : "LAST RECOVERY"}</span><strong>{date(service.latestRecoveredAt)}</strong></div>
      </div>
      {!service.exactCoverage && service.incidentFreeRatio !== null ? <div className={styles.coverage}>開始時刻を確定できないActive Incidentがあるため、Incident-free比率は上限値です。</div> : null}
      <div className={styles.serviceActions}><a href={service.detailHref}>詳細を見る</a><a href={`/incidents?range=${range}`}>Incident Center</a></div>
    </article>
  );
}
