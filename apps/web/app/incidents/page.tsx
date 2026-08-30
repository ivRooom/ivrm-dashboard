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
  type ConsoleTone,
} from "../../components/console-ui";
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

function severityTone(severity: IncidentSeverity): ConsoleTone {
  return severity === "critical" ? "danger" : "warning";
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
      <PageContent className={styles.incidentContent}>
        <PageHeader
          actions={
            <>
              <ActionLink href={`/events?range=${range}`}>生イベントを見る</ActionLink>
              <ActionLink href={`/backups?range=${range}`}>バックアップを見る</ActionLink>
            </>
          }
          description="現在進行中の障害と、開始・復旧を証明できた過去IncidentをHost / Container / Backup横断で確認します。"
          eyebrow="RELIABILITY / INCIDENT CENTER"
          title="インシデントセンター"
        />

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
          <StatePanel title="Incident情報を取得できませんでした" variant="error">
            Monitoring SnapshotとHost / Container Event RPCを確認してください。
          </StatePanel>
        ) : summary ? (
          <>
            {!backupDataAvailable ? (
              <StatePanel title="Backup Incidentだけ取得できませんでした" variant="warning">
                Host / Container Incidentは継続表示しています。Backup CenterのService Role RPCを確認してください。
              </StatePanel>
            ) : null}

            <MetricGrid label="Incidentサマリー">
              <MetricCard
                detail={`重大 ${summary.activeCriticalCount} / 注意 ${summary.activeWarningCount}`}
                label="ACTIVE"
                tone={summary.activeCriticalCount > 0 ? "danger" : summary.activeWarningCount > 0 ? "warning" : "neutral"}
                value={summary.activeCount}
              />
              <MetricCard
                detail={`${INCIDENT_RANGE_CONFIG[range].label} / 復旧時刻を証明済み`}
                label="RECOVERED"
                value={summary.recoveredCount}
              />
              <MetricCard
                detail={`${summary.exactRecoveryCount}件の確定Durationのみ`}
                label="MEDIAN RECOVERY"
                value={formatDuration(summary.medianRecoverySeconds)}
              />
              <MetricCard
                detail="推測Durationは含めない"
                label="LONGEST RECOVERY"
                value={formatDuration(summary.longestRecoverySeconds)}
              />
              <MetricCard
                detail="Host / Container / Backupの重複を除外"
                label="AFFECTED ENTITIES"
                value={summary.affectedEntityCount}
              />
              <MetricCard
                detail={`Host・Container重大/注意 / Backup Active ${summary.backupActiveCount}`}
                label="INCIDENT EVENTS"
                tone={summary.criticalEventCount > 0 ? "danger" : summary.warningEventCount > 0 ? "warning" : "neutral"}
                value={`${summary.criticalEventCount} / ${summary.warningEventCount}`}
              />
            </MetricGrid>

            <section className={styles.sectionBlock}>
              <SectionHeader
                description="Monitoring SnapshotとBackup HealthをSource of Truthとして判定します。"
                eyebrow="ACTIVE NOW"
                title="現在進行中"
              />

              {active.length === 0 ? (
                <StatePanel title="Active Incidentはありません">
                  Host / Container / Backupは現在確認できる期待状態に対して正常です。
                </StatePanel>
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
                          <StatusBadge tone={severityTone(incident.severity)}>{severityLabels[incident.severity]}</StatusBadge>
                          <StatusBadge tone="danger">ACTIVE</StatusBadge>
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
              <SectionHeader
                description="開始と復旧を構造化データから両方証明できたものだけ、Recovery Durationを算出します。"
                eyebrow="RECOVERY HISTORY"
                title="復旧済みIncident"
              />

              {recovered.length === 0 ? (
                <StatePanel title="選択期間にRecovery Durationを確定できるIncidentはありません" />
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
                            <StatusBadge tone={severityTone(incident.severity)}>{severityLabels[incident.severity]}</StatusBadge>
                            <StatusBadge tone="success">RECOVERED</StatusBadge>
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

            <StatePanel className={styles.finalNotice} title="Durationを推測しない設計" variant="info">
              ContainerはState / Health / ExitCodeのwarning・critical開始とrecoveryを同一Entity内で追跡し、重なったシグナルがすべて復旧した時点だけCloseします。Host Heartbeat gapはgap秒数からDurationを確定します。BackupはRun failure / Checksum failureの開始と次のsuccess / SHA-256 Verifiedをimmutable Run履歴から両方証明できた場合だけMTTRへ含めます。Backup Age・Remote Sync・Restore Testなど現在Policy値に依存するSLA異常はActive表示しますが、Policy履歴がないためRecovery Durationへは混ぜません。
            </StatePanel>
          </>
        ) : null}
      </PageContent>
    </>
  );
}
