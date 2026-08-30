import { AutoRefresh } from "../../components/auto-refresh";
import {
  ActionLink,
  MetricCard,
  MetricGrid,
  PageContent,
  PageHeader,
  SectionHeader,
  StatePanel,
  StatusBadge,
  TableShell,
  type ConsoleTone,
} from "../../components/console-ui";
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

type MetricTone = Exclude<ConsoleTone, "maintenance">;

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

function severityTone(severity: NotificationSeverity): ConsoleTone {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warning";
  if (severity === "recovery") return "success";
  return "info";
}

function statusTone(status: NotificationStatus): ConsoleTone {
  if (status === "sent") return "success";
  if (status === "failed") return "danger";
  if (status === "retry" || status === "pending" || status === "sending") return "warning";
  return "neutral";
}

function notificationTone(
  channelEnabled: boolean,
  channelConfigured: boolean,
  failedCount: number,
  retryCount: number,
  dispatcherStale: boolean,
  dispatcherError: boolean,
): MetricTone {
  if (failedCount > 0 || dispatcherStale || dispatcherError) return "danger";
  if (!channelConfigured || retryCount > 0) return "warning";
  if (!channelEnabled) return "info";
  return "success";
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
      <PageContent className={styles.notificationContent}>
        <PageHeader
          actions={
            <>
              <ActionLink href="/incidents">Incident Center</ActionLink>
              <ActionLink href="/reliability#burn-rate">Reliability Center</ActionLink>
              <ActionLink href="/backups">Backup Center</ActionLink>
            </>
          }
          description="Host・Container・Backup・SLO Burn Rateの異常をDurable Outboxへ集約し、発生・重大化・復旧・配送結果を同じ画面で追跡します。"
          eyebrow="ALERTING / DELIVERY / SUPPRESSION"
          title="通知センター"
        />

        {loadError ? (
          <StatePanel title="Notification情報を取得できませんでした" variant="error">
            Notification RPC・Supabase Service Role接続を確認してください。
          </StatePanel>
        ) : summary ? (
          <>
            <MetricGrid label="Notificationサマリー">
              <MetricCard
                detail={summary.channelDisplayName}
                label="NOTIFICATION HEALTH"
                tone={notificationTone(
                  summary.channelEnabled,
                  summary.channelConfigured,
                  summary.failedCount,
                  summary.retryCount,
                  dispatcherStale,
                  dispatcherError,
                )}
                value={
                  <StatusBadge
                    tone={notificationTone(
                      summary.channelEnabled,
                      summary.channelConfigured,
                      summary.failedCount,
                      summary.retryCount,
                      dispatcherStale,
                      dispatcherError,
                    )}
                  >
                    {notificationHealth}
                  </StatusBadge>
                }
              />
              <MetricCard
                detail={`重大 ${summary.activeCriticalCount} / 注意 ${summary.activeWarningCount}`}
                label="ACTIVE SIGNALS"
                tone={summary.activeCriticalCount > 0 ? "danger" : summary.activeWarningCount > 0 ? "warning" : "neutral"}
                value={summary.activeSignalCount}
              />
              <MetricCard
                detail="Pending / Retry"
                label="QUEUE"
                tone={summary.pendingCount + summary.retryCount > 0 ? "warning" : "neutral"}
                value={`${summary.pendingCount} / ${summary.retryCount}`}
              />
              <MetricCard
                detail="最大5回Retry後"
                label="FAILED"
                tone={summary.failedCount > 0 ? "danger" : "neutral"}
                value={summary.failedCount}
              />
              <MetricCard
                detail={`Latest ${formatDateTime(summary.lastDeliveryAt)}`}
                label="SENT 24H"
                value={summary.sent24hCount}
              />
              <MetricCard
                detail={`Active rules ${summary.activeSuppressionCount}`}
                label="SUPPRESSED"
                value={summary.suppressedCount}
              />
            </MetricGrid>

            <section className={styles.channelPanel}>
              <div><p className={styles.eyebrow}>DELIVERY CHANNEL</p><h2>{summary.channelDisplayName}</h2><p>Signal判定とOutboxは常時稼働し、Discord配送だけを独立してON/OFFできます。</p></div>
              <div className={styles.channelFacts}>
                <div><span>Enabled</span><strong>{summary.channelEnabled ? "ON" : "OFF"}</strong></div>
                <div><span>Webhook Secret</span><strong>{summary.channelConfigured ? "Configured" : "Not configured"}</strong></div>
                <div><span>Dispatcher</span><strong>{summary.dispatcherLastInvokedAt ? formatRelative(summary.dispatcherLastInvokedAt, generatedAt) : "未実行"}</strong></div>
                <div><span>Last Error</span><strong>{summary.dispatcherLastErrorCode ?? summary.channelLastErrorCode ?? "—"}</strong></div>
              </div>
              {!summary.channelConfigured ? (
                <StatePanel className={styles.setupNotice} title="配送セットアップ待ち" variant="warning">
                  <>Supabase Edge Function Secretへ<code>DISCORD_WEBHOOK_URL</code>を登録後、Channelを有効化します。Webhook URLはDB・Outbox・GitHubへ保存しません。</>
                </StatePanel>
              ) : null}
            </section>

            <section className={styles.sectionBlock}>
              <SectionHeader
                description="同じSignalは重複通知せず、Warning→CriticalだけをEscalationとして追加送信します。SLO Burn RateのCritical→Warningは無音で降格します。"
                eyebrow="ACTIVE SIGNALS"
                title="現在の通知対象"
              />
              {signals.length === 0 ? (
                <StatePanel title="Active Signalはありません">
                  Host Heartbeat・Container Event・Backup SLA・SLO Burn Rateは現在通知対象外です。
                </StatePanel>
              ) : (
                <div className={styles.signalGrid}>{signals.map((signal) => (
                  <article className={styles.signalCard} key={signal.signalKey}>
                    <div className={styles.cardHeading}><div><p className={styles.entityType}>{signalKey(signal)}</p><h3>{signal.entityName}</h3><small>{signal.serverId}</small></div><StatusBadge tone={severityTone(signal.severity)}>{severityLabels[signal.severity]}</StatusBadge></div>
                    <p className={styles.reason}>{signal.reason}</p>
                    <div className={styles.signalMeta}><span>開始 {formatDateTime(signal.openedAt)}</span><span>最終確認 {formatRelative(signal.lastSeenAt, generatedAt)}</span></div>
                    <a className={styles.inlineLink} href={signal.detailHref}>対象を開く</a>
                  </article>
                ))}</div>
              )}
            </section>

            <section className={styles.sectionBlock}>
              <SectionHeader
                description="Webhook本文そのものではなく、配送判断に必要な構造化フィールドと結果だけを保持します。"
                eyebrow="DELIVERY HISTORY"
                title="通知履歴"
              />
              {deliveries.length === 0 ? (
                <StatePanel title="通知Outboxはまだ空です" />
              ) : (
                <TableShell className={styles.tableShell} label="通知履歴">
                  <table><thead><tr><th>日時</th><th>対象</th><th>Transition</th><th>内容</th><th>Status</th><th>Delivery</th></tr></thead><tbody>
                    {deliveries.map((delivery) => <tr key={delivery.rowId}>
                      <td>{formatDateTime(delivery.occurredAt)}<small>{formatRelative(delivery.occurredAt, generatedAt)}</small></td>
                      <td><strong>{delivery.entityName}</strong><small>{deliveryMeta(delivery)}</small></td>
                      <td><StatusBadge tone={severityTone(delivery.severity)}>{transitionLabels[delivery.transition]} / {severityLabels[delivery.severity]}</StatusBadge></td>
                      <td><strong>{delivery.title}</strong><small>{delivery.message}</small><a href={delivery.detailHref}>詳細</a></td>
                      <td><StatusBadge tone={statusTone(delivery.status)}>{statusLabels[delivery.status]}</StatusBadge><small>{delivery.suppressionReason ?? delivery.lastErrorCode ?? "—"}</small></td>
                      <td>{delivery.sentAt ? formatDateTime(delivery.sentAt) : "—"}<small>{delivery.attempts} attempts</small></td>
                    </tr>)}
                  </tbody></table>
                </TableShell>
              )}
            </section>

            <section className={styles.sectionBlock}>
              <SectionHeader
                description="Container Maintenanceに加え、Global / Host / Container / Backup / Reliability / Signal単位で通知だけを抑制できます。"
                eyebrow="SUPPRESSION"
                title="通知抑制"
              />
              {suppressions.length === 0 ? (
                <StatePanel title="明示的な通知抑制ルールはありません" />
              ) : (
                <div className={styles.suppressionList}>{suppressions.map((rule) => <article key={rule.rowId}><span>{rule.scopeType.toUpperCase()}</span><strong>{rule.scopeKey}</strong><p>{rule.reason}</p><small>{formatDateTime(rule.startsAt)} → {formatDateTime(rule.endsAt)}</small></article>)}</div>
              )}
            </section>

            <StatePanel title="通知を監視処理から分離" variant="info">
              Host OfflineはAgent自身ではなくSupabase CronがHeartbeatを再評価し、SLO Burn Rateは認証付きReconcilerが1h / 6h / 24hの確定Coverageを評価します。配送はOutboxからClaimして最大5回Retryし、Secret・Webhook URL・生ログ・Player IP・Cookie・Tokenは通知履歴へ保存しません。
            </StatePanel>
          </>
        ) : null}
      </PageContent>
    </>
  );
}
