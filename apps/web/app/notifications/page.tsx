import { AutoRefresh } from "../../components/auto-refresh";
import {
  getNotificationCenterSnapshot,
  type NotificationDelivery,
  type NotificationSeverity,
  type NotificationSignal,
  type NotificationSource,
  type NotificationStatus,
} from "../../lib/notifications";
import styles from "./notifications.module.css";

export const dynamic = "force-dynamic";

const severityLabels: Record<NotificationSeverity, string> = {
  info: "情報", warning: "注意", critical: "重大", recovery: "復旧",
};
const statusLabels: Record<NotificationStatus, string> = {
  pending: "待機", sending: "配送中", sent: "送信済み", retry: "再試行", failed: "失敗", suppressed: "抑制",
};
const sourceLabels: Record<NotificationSource, string> = {
  host: "HOST", container: "CONTAINER", backup: "BACKUP", reliability: "SLO",
};
const transitionLabels = { opened: "発生", escalated: "重大化", recovered: "復旧", event: "イベント" } as const;
const signalLabels: Record<string, string> = {
  heartbeat: "Heartbeat", state_changed: "State", health_changed: "Health", exit_code_changed: "ExitCode",
  run_failure: "Backup Run", checksum: "Checksum", backup_age: "Backup Age", remote_sync: "Remote Sync",
  retention: "Retention", restore_test: "Restore Test", slo_burn_rate: "SLO Burn Rate",
};

function formatDateTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "short", timeStyle: "medium", timeZone: "Asia/Tokyo" }).format(new Date(value));
}

function formatRelative(value: string | null, now: string): string {
  if (!value) return "—";
  const diff = Math.max(0, Math.floor((Date.parse(now) - Date.parse(value)) / 1000));
  if (!Number.isFinite(diff)) return "—";
  if (diff < 60) return `${diff}秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
  return `${Math.floor(diff / 86400)}日前`;
}

function severityClass(severity: NotificationSeverity): string {
  return severity === "critical" ? styles.critical : severity === "warning" ? styles.warning : severity === "recovery" ? styles.recovery : styles.info;
}

function statusClass(status: NotificationStatus): string {
  if (status === "sent") return styles.recovery;
  if (status === "failed") return styles.critical;
  if (status === "retry" || status === "pending" || status === "sending") return styles.warning;
  return styles.muted;
}

function signalKey(signal: NotificationSignal): string {
  return `${sourceLabels[signal.sourceType]} / ${signalLabels[signal.signalType] ?? signal.signalType}`;
}

function deliveryMeta(delivery: NotificationDelivery): string {
  const details = [sourceLabels[delivery.sourceType], delivery.serverId, `${delivery.attempts} attempt${delivery.attempts === 1 ? "" : "s"}`];
  if (delivery.lastHttpStatus !== null) details.push(`HTTP ${delivery.lastHttpStatus}`);
  return details.join(" / ");
}

export default async function NotificationsPage() {
  let data = null;
  let loadError = false;
  try {
    data = await getNotificationCenterSnapshot();
  } catch (error) {
    loadError = true;
    console.error("Notification Centerの取得に失敗しました", error);
  }

  const summary = data?.summary ?? null;
  const generatedAt = summary?.generatedAt ?? new Date().toISOString();
  const signals = data?.signals ?? [];
  const deliveries = data?.deliveries ?? [];
  const suppressions = data?.suppressions ?? [];
  const dispatcherStale = Boolean(
    summary?.channelEnabled && summary.channelConfigured &&
    (!summary.dispatcherLastInvokedAt || Date.parse(generatedAt) - Date.parse(summary.dispatcherLastInvokedAt) > 180_000),
  );
  const dispatcherError = Boolean(
    summary?.channelEnabled && summary.channelConfigured &&
    (summary.dispatcherLastErrorCode || summary.channelLastErrorCode),
  );
  const notificationHealth = loadError ? "取得エラー"
    : !summary?.channelEnabled ? "監視のみ"
    : !summary.channelConfigured ? "設定待ち"
    : summary.failedCount > 0 || dispatcherStale || dispatcherError ? "要確認"
    : summary.retryCount > 0 ? "再試行中"
    : "正常";

  return (
    <>
      <AutoRefresh intervalMs={30_000} />
      <section className={`content ${styles.notificationContent}`}>
        <header className={styles.pageHeader}>
          <div>
            <p className={styles.eyebrow}>ALERTING / DELIVERY / SUPPRESSION</p>
            <h1>通知センター</h1>
            <p>Host・Container・Backup・SLO Burn Rateの異常をDurable Outboxへ集約し、発生・重大化・復旧・配送結果を同じ画面で追跡します。</p>
          </div>
          <div className={styles.headerActions}><a href="/incidents" className={styles.secondaryLink}>Incident Center</a><a href="/reliability#burn-rate" className={styles.secondaryLink}>Reliability Center</a><a href="/backups" className={styles.secondaryLink}>Backup Center</a></div>
        </header>

        {loadError ? (
          <div className="empty error-panel" role="alert"><strong>Notification情報を取得できませんでした</strong><p>Notification RPC・Supabase Service Role接続を確認してください。</p></div>
        ) : summary ? (
          <>
            <section className={styles.summaryGrid} aria-label="Notificationサマリー">
              <article className={summary.failedCount || dispatcherStale || dispatcherError ? styles.critical : summary.retryCount ? styles.warning : undefined}><span>NOTIFICATION HEALTH</span><strong>{notificationHealth}</strong><small>{summary.channelDisplayName}</small></article>
              <article><span>ACTIVE SIGNALS</span><strong>{summary.activeSignalCount}</strong><small>重大 {summary.activeCriticalCount} / 注意 {summary.activeWarningCount}</small></article>
              <article className={summary.pendingCount + summary.retryCount > 0 ? styles.warning : undefined}><span>QUEUE</span><strong>{summary.pendingCount} / {summary.retryCount}</strong><small>Pending / Retry</small></article>
              <article className={summary.failedCount > 0 ? styles.critical : undefined}><span>FAILED</span><strong>{summary.failedCount}</strong><small>最大5回Retry後</small></article>
              <article><span>SENT 24H</span><strong>{summary.sent24hCount}</strong><small>Latest {formatDateTime(summary.lastDeliveryAt)}</small></article>
              <article className={summary.suppressedCount > 0 ? styles.muted : undefined}><span>SUPPRESSED</span><strong>{summary.suppressedCount}</strong><small>Active rules {summary.activeSuppressionCount}</small></article>
            </section>

            <section className={styles.channelPanel}>
              <div><p className={styles.eyebrow}>DELIVERY CHANNEL</p><h2>{summary.channelDisplayName}</h2><p>Signal判定とOutboxは常時稼働し、Discord配送だけを独立してON/OFFできます。</p></div>
              <div className={styles.channelFacts}>
                <div><span>Enabled</span><strong>{summary.channelEnabled ? "ON" : "OFF"}</strong></div>
                <div><span>Webhook Secret</span><strong>{summary.channelConfigured ? "Configured" : "Not configured"}</strong></div>
                <div><span>Dispatcher</span><strong>{summary.dispatcherLastInvokedAt ? formatRelative(summary.dispatcherLastInvokedAt, generatedAt) : "未実行"}</strong></div>
                <div><span>Last Error</span><strong>{summary.dispatcherLastErrorCode ?? summary.channelLastErrorCode ?? "—"}</strong></div>
              </div>
              {!summary.channelConfigured ? <div className={styles.setupNotice}><strong>配送セットアップ待ち</strong><p>Supabase Edge Function Secretへ<code>DISCORD_WEBHOOK_URL</code>を登録後、Channelを有効化します。Webhook URLはDB・Outbox・GitHubへ保存しません。</p></div> : null}
            </section>

            <section className={styles.sectionBlock}>
              <div className={styles.sectionHeading}><div><span>ACTIVE SIGNALS</span><h2>現在の通知対象</h2></div><p>同じSignalは重複通知せず、Warning→CriticalだけをEscalationとして追加送信します。SLO Burn RateのCritical→Warningは無音で降格します。</p></div>
              {signals.length === 0 ? <div className={styles.emptyState}><strong>Active Signalはありません</strong><p>Host Heartbeat・Container Event・Backup SLA・SLO Burn Rateは現在通知対象外です。</p></div> : (
                <div className={styles.signalGrid}>{signals.map((signal) => (
                  <article className={styles.signalCard} key={signal.signalKey}>
                    <div className={styles.cardHeading}><div><p className={styles.entityType}>{signalKey(signal)}</p><h3>{signal.entityName}</h3><small>{signal.serverId}</small></div><span className={`${styles.badge} ${severityClass(signal.severity)}`}>{severityLabels[signal.severity]}</span></div>
                    <p className={styles.reason}>{signal.reason}</p>
                    <div className={styles.signalMeta}><span>開始 {formatDateTime(signal.openedAt)}</span><span>最終確認 {formatRelative(signal.lastSeenAt, generatedAt)}</span></div>
                    <a className={styles.inlineLink} href={signal.detailHref}>対象を開く</a>
                  </article>
                ))}</div>
              )}
            </section>

            <section className={styles.sectionBlock}>
              <div className={styles.sectionHeading}><div><span>DELIVERY HISTORY</span><h2>通知履歴</h2></div><p>Webhook本文そのものではなく、配送判断に必要な構造化フィールドと結果だけを保持します。</p></div>
              {deliveries.length === 0 ? <div className={styles.emptyState}>通知Outboxはまだ空です。</div> : (
                <div className={styles.tableShell}><table><thead><tr><th>日時</th><th>対象</th><th>Transition</th><th>内容</th><th>Status</th><th>Delivery</th></tr></thead><tbody>
                  {deliveries.map((delivery) => <tr key={delivery.rowId}>
                    <td>{formatDateTime(delivery.occurredAt)}<small>{formatRelative(delivery.occurredAt, generatedAt)}</small></td>
                    <td><strong>{delivery.entityName}</strong><small>{deliveryMeta(delivery)}</small></td>
                    <td><span className={`${styles.badge} ${severityClass(delivery.severity)}`}>{transitionLabels[delivery.transition]} / {severityLabels[delivery.severity]}</span></td>
                    <td><strong>{delivery.title}</strong><small>{delivery.message}</small><a href={delivery.detailHref}>詳細</a></td>
                    <td><span className={`${styles.badge} ${statusClass(delivery.status)}`}>{statusLabels[delivery.status]}</span><small>{delivery.suppressionReason ?? delivery.lastErrorCode ?? "—"}</small></td>
                    <td>{delivery.sentAt ? formatDateTime(delivery.sentAt) : "—"}<small>{delivery.attempts} attempts</small></td>
                  </tr>)}
                </tbody></table></div>
              )}
            </section>

            <section className={styles.sectionBlock}>
              <div className={styles.sectionHeading}><div><span>SUPPRESSION</span><h2>通知抑制</h2></div><p>Container Maintenanceに加え、Global / Host / Container / Backup / Reliability / Signal単位で通知だけを抑制できます。</p></div>
              {suppressions.length === 0 ? <div className={styles.emptyState}>明示的な通知抑制ルールはありません。</div> : (
                <div className={styles.suppressionList}>{suppressions.map((rule) => <article key={rule.rowId}><span>{rule.scopeType.toUpperCase()}</span><strong>{rule.scopeKey}</strong><p>{rule.reason}</p><small>{formatDateTime(rule.startsAt)} → {formatDateTime(rule.endsAt)}</small></article>)}</div>
              )}
            </section>

            <section className={styles.notice}><strong>通知を監視処理から分離</strong><p>Host OfflineはAgent自身ではなくSupabase CronがHeartbeatを再評価し、SLO Burn Rateは認証付きReconcilerが1h / 6h / 24hの確定Coverageを評価します。配送はOutboxからClaimして最大5回Retryし、Secret・Webhook URL・生ログ・Player IP・Cookie・Tokenは通知履歴へ保存しません。</p></section>
          </>
        ) : null}
      </section>
    </>
  );
}
