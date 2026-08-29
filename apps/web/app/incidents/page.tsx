import { AutoRefresh } from "../../components/auto-refresh";
import {
  INCIDENT_RANGE_CONFIG,
  getUnifiedIncidentCenterSnapshot,
  parseIncidentRange,
  type ActiveIncident,
  type IncidentRange,
  type IncidentSeverity,
  type RecoveredIncident,
} from "../../lib/unified-incidents";
import styles from "./incidents.module.css";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const severityLabels: Record<IncidentSeverity, string> = {
  critical: "重大",
  warning: "注意",
};

const currentStatusLabels: Record<ActiveIncident["currentStatus"], string> = {
  error: "異常",
  stale: "更新遅延",
  offline: "受信停止",
  degraded: "保護異常",
};

function firstValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function formatDateTime(timestamp: string | null): string {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "不明";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Asia/Tokyo",
  }).format(new Date(timestamp));
}

function formatRelativeTime(timestamp: string | null, reference: string): string {
  if (!timestamp) return "時刻不明";
  const target = Date.parse(timestamp);
  const now = Date.parse(reference);
  if (!Number.isFinite(target) || !Number.isFinite(now)) return "時刻不明";
  const seconds = Math.max(0, Math.floor((now - target) / 1_000));
  if (seconds < 60) return `${seconds}秒前`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}時間前`;
  return `${Math.floor(seconds / 86_400)}日前`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "算出対象外";
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3_600) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest > 0 ? `${minutes}分 ${rest}秒` : `${minutes}分`;
  }
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    return minutes > 0 ? `${hours}時間 ${minutes}分` : `${hours}時間`;
  }
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return hours > 0 ? `${days}日 ${hours}時間` : `${days}日`;
}

function entityName(incident: ActiveIncident | RecoveredIncident): string {
  if (incident.entityType === "backup") return incident.backupTarget;
  return incident.containerName ?? incident.hostDisplayName;
}

function entityMeta(incident: ActiveIncident | RecoveredIncident): string {
  if (incident.entityType === "backup") {
    return `${incident.gameMode} / ${incident.backupType.toUpperCase()} / ${incident.hostDisplayName} / ${incident.serverId}`;
  }
  return incident.containerName
    ? `${incident.hostDisplayName} / ${incident.serverId}`
    : `${incident.serverId} / Host`;
}

function entityTypeLabel(incident: ActiveIncident | RecoveredIncident): string {
  if (incident.entityType === "backup") return "BACKUP";
  return incident.entityType === "host" ? "HOST" : "CONTAINER";
}

function severityClass(severity: IncidentSeverity): string {
  return severity === "critical" ? styles.critical : styles.warning;
}

export default async function IncidentsPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const range = parseIncidentRange(firstValue(query.range));
  let data = null;
  let loadError = false;

  try {
    data = await getUnifiedIncidentCenterSnapshot(range);
  } catch (error) {
    loadError = true;
    console.error("Incident Centerの取得に失敗しました", error);
  }

  const generatedAt = data?.generatedAt ?? new Date().toISOString();
  const active = data?.active ?? [];
  const recovered = data?.recovered ?? [];
  const summary = data?.summary ?? null;
  const backupDataAvailable = data?.backupDataAvailable ?? false;

  return (
    <>
      <AutoRefresh intervalMs={30_000} />
      <section className={`content ${styles.incidentContent}`}>
        <header>
          <div>
            <p className={styles.eyebrow}>RELIABILITY / INCIDENT CENTER</p>
            <h1>インシデントセンター</h1>
            <p>現在進行中の障害と、開始・復旧を証明できた過去IncidentをHost / Container / Backup横断で確認します。</p>
          </div>
          <div className={styles.headerActions}>
            <a className={styles.secondaryLink} href={`/events?range=${range}`}>生イベントを見る</a>
            <a className={styles.secondaryLink} href={`/backups?range=${range}`}>バックアップを見る</a>
          </div>
        </header>

        <nav className={styles.periodSelector} aria-label="信頼性集計期間">
          {(Object.keys(INCIDENT_RANGE_CONFIG) as IncidentRange[]).map((candidate) => (
            <a
              key={candidate}
              aria-current={candidate === range ? "page" : undefined}
              className={candidate === range ? styles.activePeriod : undefined}
              href={`/incidents?range=${candidate}`}
            >
              {INCIDENT_RANGE_CONFIG[candidate].label}
            </a>
          ))}
        </nav>

        {loadError ? (
          <div className="empty error-panel" role="alert">
            <strong>Incident情報を取得できませんでした</strong>
            <p>Monitoring SnapshotとHost / Container Event RPCを確認してください。</p>
          </div>
        ) : summary ? (
          <>
            {!backupDataAvailable ? (
              <section className={styles.notice}>
                <strong>Backup Incidentだけ取得できませんでした</strong>
                <p>Host / Container Incidentは継続表示しています。Backup CenterのService Role RPCを確認してください。</p>
              </section>
            ) : null}

            <section className={styles.summaryGrid} aria-label="Incidentサマリー">
              <article className={summary.activeCount > 0 ? styles.summaryAttention : undefined}>
                <span>ACTIVE</span>
                <strong>{summary.activeCount}</strong>
                <small>重大 {summary.activeCriticalCount} / 注意 {summary.activeWarningCount}</small>
              </article>
              <article>
                <span>RECOVERED</span>
                <strong>{summary.recoveredCount}</strong>
                <small>{INCIDENT_RANGE_CONFIG[range].label} / 復旧時刻を証明済み</small>
              </article>
              <article>
                <span>MEDIAN RECOVERY</span>
                <strong>{formatDuration(summary.medianRecoverySeconds)}</strong>
                <small>{summary.exactRecoveryCount}件の確定Durationのみ</small>
              </article>
              <article>
                <span>LONGEST RECOVERY</span>
                <strong>{formatDuration(summary.longestRecoverySeconds)}</strong>
                <small>推測Durationは含めない</small>
              </article>
              <article>
                <span>AFFECTED ENTITIES</span>
                <strong>{summary.affectedEntityCount}</strong>
                <small>Host / Container / Backupの重複を除外</small>
              </article>
              <article>
                <span>INCIDENT EVENTS</span>
                <strong>{summary.criticalEventCount} / {summary.warningEventCount}</strong>
                <small>Host・Container重大/注意 / Backup Active {summary.backupActiveCount}</small>
              </article>
            </section>

            <section className={styles.sectionBlock}>
              <div className={styles.sectionHeading}>
                <div><span>ACTIVE NOW</span><h2>現在進行中</h2></div>
                <p>Monitoring SnapshotとBackup HealthをSource of Truthとして判定します。</p>
              </div>

              {active.length === 0 ? (
                <div className={styles.healthyState}>
                  <strong>Active Incidentはありません</strong>
                  <p>Host / Container / Backupは現在確認できる期待状態に対して正常です。</p>
                </div>
              ) : (
                <div className={styles.activeGrid}>
                  {active.map((incident) => (
                    <article className={styles.incidentCard} key={incident.id}>
                      <div className={styles.cardHeading}>
                        <div>
                          <p className={styles.entityType}>{entityTypeLabel(incident)}</p>
                          <h3>{entityName(incident)}</h3>
                          <small>{entityMeta(incident)}</small>
                        </div>
                        <div className={styles.badges}>
                          <span className={`${styles.badge} ${severityClass(incident.severity)}`}>{severityLabels[incident.severity]}</span>
                          <span className={`${styles.badge} ${styles.activeBadge}`}>ACTIVE</span>
                        </div>
                      </div>

                      <div className={styles.metricGrid}>
                        <div><span>現在状態</span><strong>{currentStatusLabels[incident.currentStatus]}</strong></div>
                        <div><span>開始</span><strong>{incident.exactStart ? formatRelativeTime(incident.startedAt, generatedAt) : "開始時刻不明"}</strong><small>{incident.exactStart ? formatDateTime(incident.startedAt) : "推測しません"}</small></div>
                        <div><span>継続時間</span><strong>{formatDuration(incident.durationSeconds)}</strong><small>{incident.exactStart ? "Structured Data基準" : "算出対象外"}</small></div>
                        <div><span>関連イベント</span><strong>{incident.relatedEventCount}</strong><small>{incident.entityType === "backup" ? "30日Backup Run" : "30日Context"}</small></div>
                      </div>

                      <div className={styles.reasonBox}>
                        <span>開始理由</span>
                        <strong>{incident.startReason}</strong>
                        <small>{incident.latestTransition ? `最新: ${incident.latestTransition} / ${formatRelativeTime(incident.latestTransitionAt, generatedAt)}` : "追加Transitionなし"}</small>
                      </div>

                      <div className={styles.cardActions}>
                        <a href={incident.detailHref}>{incident.entityType === "backup" ? "Backup Centerを開く" : "詳細を開く"}</a>
                        {incident.entityType !== "backup" ? <a href={incident.eventsHref}>関連イベント</a> : null}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className={styles.sectionBlock}>
              <div className={styles.sectionHeading}>
                <div><span>RECOVERY HISTORY</span><h2>復旧済みIncident</h2></div>
                <p>開始と復旧を構造化データから両方証明できたものだけ、Recovery Durationを算出します。</p>
              </div>

              {recovered.length === 0 ? (
                <div className={styles.emptyState}>選択期間にRecovery Durationを確定できるIncidentはありません。</div>
              ) : (
                <div className={styles.recoveredList}>
                  {recovered.map((incident) => (
                    <article className={styles.recoveredRow} key={incident.id}>
                      <div className={styles.recoveredMain}>
                        <div className={styles.cardHeading}>
                          <div>
                            <p className={styles.entityType}>{entityTypeLabel(incident)}</p>
                            <h3>{entityName(incident)}</h3>
                            <small>{entityMeta(incident)}</small>
                          </div>
                          <div className={styles.badges}>
                            <span className={`${styles.badge} ${severityClass(incident.severity)}`}>{severityLabels[incident.severity]}</span>
                            <span className={`${styles.badge} ${styles.recoveredBadge}`}>RECOVERED</span>
                          </div>
                        </div>
                        <p className={styles.transition}><strong>{incident.startReason}</strong><span>→</span><strong>{incident.recoveryReason}</strong></p>
                      </div>
                      <div className={styles.recoveryMetrics}>
                        <div><span>開始</span><strong>{formatDateTime(incident.startedAt)}</strong></div>
                        <div><span>復旧</span><strong>{formatDateTime(incident.recoveredAt)}</strong><small>{formatRelativeTime(incident.recoveredAt, generatedAt)}</small></div>
                        <div><span>Recovery Time</span><strong>{formatDuration(incident.durationSeconds)}</strong><small>{incident.relatedEventCount} {incident.entityType === "backup" ? "runs" : "events"}</small></div>
                      </div>
                      <div className={styles.cardActions}>
                        <a href={incident.detailHref}>{incident.entityType === "backup" ? "Backup Center" : "詳細"}</a>
                        {incident.entityType !== "backup" ? <a href={incident.eventsHref}>イベント</a> : null}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className={styles.notice}>
              <strong>Durationを推測しない設計</strong>
              <p>ContainerはState / Health / ExitCodeのwarning・critical開始とrecoveryを同一Entity内で追跡し、重なったシグナルがすべて復旧した時点だけCloseします。Host Heartbeat gapはgap秒数からDurationを確定します。BackupはRun failure / Checksum failureの開始と次のsuccess / SHA-256 Verifiedをimmutable Run履歴から両方証明できた場合だけMTTRへ含めます。Backup Age・Remote Sync・Restore Testなど現在Policy値に依存するSLA異常はActive表示しますが、Policy履歴がないためRecovery Durationへは混ぜません。</p>
            </section>
          </>
        ) : null}
      </section>
    </>
  );
}
