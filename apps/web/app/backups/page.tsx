import { AutoRefresh } from "../../components/auto-refresh";
import { MetricLineChart, type MetricChartMarker } from "../../components/metric-line-chart";
import {
  BACKUP_RANGE_CONFIG,
  getBackupCenterSnapshot,
  parseBackupRange,
  type BackupHealth,
  type BackupRange,
  type BackupTargetSnapshot,
} from "../../lib/backups";
import type { BackupFailureCode, BackupOutcome, BackupType } from "../../lib/backup-report";
import styles from "./backups.module.css";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const healthLabels: Record<BackupHealth, string> = {
  healthy: "正常",
  warning: "注意",
  critical: "重大",
  unknown: "未確認",
};

const outcomeLabels: Record<BackupOutcome, string> = {
  success: "成功",
  failed: "失敗",
  running: "実行中",
  unknown: "不明",
};

const typeLabels: Record<BackupType, string> = {
  world: "World",
  config: "設定",
  permissions: "権限",
  full: "Full",
};

const failureLabels: Record<BackupFailureCode, string> = {
  source_unavailable: "Source取得不可",
  archive_failed: "Archive作成失敗",
  checksum_failed: "Checksum失敗",
  remote_sync_failed: "Remote Sync失敗",
  retention_failed: "Retention処理失敗",
  timeout: "Timeout",
  permission_denied: "権限不足",
  insufficient_space: "空き容量不足",
  unknown: "原因未分類",
};

function firstValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function formatDateTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}分`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}時間`;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return hours > 0 ? `${days}日 ${hours}時間` : `${days}日`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}時間 ${rest}分` : `${hours}時間`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1_024 ** 3).toFixed(2)} GiB`;
}

function targetKey(target: Pick<BackupTargetSnapshot, "hostId" | "backupTarget" | "gameMode" | "backupType">): string {
  return `${target.hostId}:${target.backupTarget}:${target.gameMode}:${target.backupType}`;
}

function targetAnchor(target: Pick<BackupTargetSnapshot, "hostId" | "backupTarget" | "gameMode" | "backupType">): string {
  return `backup-target-${target.hostId}-${target.backupTarget}-${target.gameMode}-${target.backupType}`;
}

function healthClass(health: BackupHealth): string {
  return {
    healthy: styles.healthy,
    warning: styles.warning,
    critical: styles.critical,
    unknown: styles.unknown,
  }[health];
}

export default async function BackupsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const range = parseBackupRange(firstValue(params.range));
  const config = BACKUP_RANGE_CONFIG[range];
  let data = null;
  let loadError = false;

  try {
    data = await getBackupCenterSnapshot(range);
  } catch (error) {
    loadError = true;
    console.error("Backup Centerの取得に失敗しました", error);
  }

  const targets = data?.targets ?? [];
  const history = data?.history ?? [];
  const summary = data?.summary ?? null;
  const endAt = data?.generatedAt ?? new Date().toISOString();
  const startAt = new Date(Date.parse(endAt) - config.hours * 3_600_000).toISOString();

  const seriesTargets = new Map<string, { label: string; target: BackupTargetSnapshot }>();
  for (const target of targets) {
    seriesTargets.set(targetKey(target), {
      label: `${target.backupTarget} / ${target.gameMode} / ${target.hostDisplayName}`,
      target,
    });
  }

  const durationSeries = [...seriesTargets.entries()].map(([key, item]) => ({
    id: `${key}:duration`,
    label: item.label,
    points: history
      .filter((run) => `${run.hostId}:${run.backupTarget}:${run.gameMode}:${run.backupType}` === key)
      .filter((run) => run.completedAt !== null)
      .map((run) => ({ timestamp: run.completedAt as string, value: run.durationSeconds })),
  }));

  const sizeSeries = [...seriesTargets.entries()].map(([key, item]) => ({
    id: `${key}:size`,
    label: item.label,
    points: history
      .filter((run) => `${run.hostId}:${run.backupTarget}:${run.gameMode}:${run.backupType}` === key)
      .filter((run) => run.completedAt !== null)
      .map((run) => ({
        timestamp: run.completedAt as string,
        value: run.sizeBytes === null ? null : run.sizeBytes / 1_024 ** 3,
      })),
  }));

  const failureMarkers: MetricChartMarker[] = history
    .filter((run) => run.outcome === "failed" && run.completedAt)
    .map((run) => ({
      id: `backup-failure-${run.rowId}`,
      timestamp: run.completedAt as string,
      label: `${run.backupTarget}: ${run.failureCode ? failureLabels[run.failureCode] : "失敗"}`,
      severity: "critical" as const,
    }));

  return (
    <main className="shell">
      <AutoRefresh intervalMs={config.refreshMs} />

      <aside className="sidebar">
        <a className="brand" href="/#top"><span>IV</span><strong>IVRM Console</strong></a>
        <nav aria-label="メインナビゲーション">
          <a href="/#top">概要</a>
          <a href="/minecraft">Minecraft</a>
          <a href="/hosts">ホスト</a>
          <a href="/containers">コンテナ</a>
          <a href={`/incidents?range=${range}`}>インシデント</a>
          <a aria-current="page" href={`/backups?range=${range}`}>バックアップ</a>
          <a href={`/events?range=${range}`}>イベント</a>
          <a href={`/history?range=${range}`}>履歴グラフ</a>
        </nav>
        <div className="agent">
          <i className={loadError ? "error" : summary?.overallHealth === "critical" ? "error" : summary?.overallHealth === "warning" ? "stale" : "online"} />
          Backup Center<br />
          <small>{loadError ? "取得エラー" : summary ? `${healthLabels[summary.overallHealth]} / ${summary.targetCount} targets` : "Telemetry待機中"}</small>
        </div>
      </aside>

      <section className={`content ${styles.backupContent}`}>
        <header className={styles.pageHeader}>
          <div>
            <p className={styles.eyebrow}>DATA PROTECTION / RESTORE READINESS</p>
            <h1>バックアップセンター</h1>
            <p>最新バックアップの鮮度・整合性・Remote Sync・Retention・Restore Testを、実行操作なしの読み取り専用で確認します。</p>
          </div>
          <div className={styles.headerActions}>
            <a href="/incidents" className={styles.secondaryLink}>インシデントを見る</a>
            <a href="/hosts" className={styles.secondaryLink}>ホストを見る</a>
          </div>
        </header>

        <nav className={styles.periodSelector} aria-label="Backup履歴集計期間">
          {(Object.keys(BACKUP_RANGE_CONFIG) as BackupRange[]).map((candidate) => (
            <a
              key={candidate}
              aria-current={candidate === range ? "page" : undefined}
              className={candidate === range ? styles.activePeriod : undefined}
              href={`/backups?range=${candidate}`}
            >
              {BACKUP_RANGE_CONFIG[candidate].label}
            </a>
          ))}
        </nav>

        {loadError ? (
          <div className="empty error-panel" role="alert">
            <strong>Backup情報を取得できませんでした</strong>
            <p>Backup Center Migration・Service Role RPC・Supabase接続を確認してください。</p>
          </div>
        ) : summary ? (
          <>
            <section className={styles.summaryGrid} aria-label="Backupサマリー">
              <article className={healthClass(summary.overallHealth)}>
                <span>BACKUP HEALTH</span>
                <strong>{healthLabels[summary.overallHealth]}</strong>
                <small>正常 {summary.healthyCount} / 注意 {summary.warningCount} / 重大 {summary.criticalCount} / 未確認 {summary.unknownCount}</small>
              </article>
              <article>
                <span>LATEST SUCCESS</span>
                <strong>{formatDateTime(summary.latestSuccessAt)}</strong>
                <small>{config.label}の構造化履歴</small>
              </article>
              <article>
                <span>SUCCESS RATE</span>
                <strong>{summary.successRatePercent === null ? "—" : `${summary.successRatePercent.toFixed(1)}%`}</strong>
                <small>{summary.successRunCount} / {summary.completedRunCount} completed</small>
              </article>
              <article className={summary.latestFailureAt ? styles.warning : undefined}>
                <span>LATEST FAILURE</span>
                <strong>{formatDateTime(summary.latestFailureAt)}</strong>
                <small>成功で上書きせず履歴として保持</small>
              </article>
              <article className={summary.remoteSyncPendingCount > 0 ? styles.warning : undefined}>
                <span>REMOTE SYNC</span>
                <strong>{summary.remoteSyncPendingCount}</strong>
                <small>未同期Target</small>
              </article>
              <article>
                <span>RESTORE READY</span>
                <strong>{summary.restoreReadyCount} / {summary.targetCount}</strong>
                <small>Checksum + Retention + Restore Test確認済み</small>
              </article>
            </section>

            <section className={styles.sectionBlock}>
              <div className={styles.sectionHeading}>
                <div><span>PROTECTION TARGETS</span><h2>バックアップ対象</h2></div>
                <p>欠損値は正常扱いせず、証明できた状態だけをHealthy / Restore Readyとして表示します。</p>
              </div>

              {targets.length === 0 ? (
                <div className={styles.emptyState}>
                  <strong>Backup Telemetryはまだありません</strong>
                  <p>署名付きBackup Reportを初めて受信するとPolicyが安全な既定SLAで自動登録され、この画面にTargetが追加されます。</p>
                  <code>POST /api/agent/backups</code>
                </div>
              ) : (
                <div className={styles.targetGrid}>
                  {targets.map((target) => (
                    <article id={targetAnchor(target)} className={styles.targetCard} key={target.policyId}>
                      <div className={styles.cardHeading}>
                        <div>
                          <p className={styles.entityType}>{typeLabels[target.backupType]} / {target.gameMode}</p>
                          <h3>{target.backupTarget}</h3>
                          <small>{target.hostDisplayName} / {target.serverId}</small>
                        </div>
                        <span className={`${styles.badge} ${healthClass(target.health)}`}>{healthLabels[target.health]}</span>
                      </div>

                      <div className={styles.metricGrid}>
                        <div><span>Backup Age</span><strong>{formatAge(target.backupAgeSeconds)}</strong><small>Warn {formatAge(target.warningAfterSeconds)} / Crit {formatAge(target.criticalAfterSeconds)}</small></div>
                        <div><span>最新結果</span><strong>{target.latest ? outcomeLabels[target.latest.outcome] : "—"}</strong><small>{formatDateTime(target.latest?.completedAt ?? target.latest?.startedAt ?? null)}</small></div>
                        <div><span>容量</span><strong>{formatBytes(target.latestSuccess?.sizeBytes ?? null)}</strong><small>最新成功Run</small></div>
                        <div><span>所要時間</span><strong>{formatDuration(target.latest?.durationSeconds ?? null)}</strong><small>最新Run</small></div>
                        <div><span>SHA-256</span><strong>{target.latestSuccess?.sha256Verified === true ? "Verified" : target.latestSuccess?.sha256Verified === false ? "Failed" : "Unknown"}</strong><small>推測しません</small></div>
                        <div><span>Remote Sync</span><strong>{!target.remoteSyncRequired ? "任意" : target.latestSuccess?.remoteSyncedAt ? "Synced" : "Pending"}</strong><small>{formatDateTime(target.latestSuccess?.remoteSyncedAt ?? null)}</small></div>
                        <div><span>Retention</span><strong>{formatDateTime(target.latestSuccess?.retentionExpiresAt ?? null)}</strong><small>期限未取得はReady扱いしない</small></div>
                        <div><span>Restore Test</span><strong>{target.restoreReadiness === "ready" ? "Ready" : target.restoreReadiness === "warning" ? "Stale" : "Unknown"}</strong><small>{formatDateTime(target.latestSuccess?.restoreTestedAt ?? null)}</small></div>
                      </div>

                      <div className={styles.reasonBox}>
                        {target.healthReasons.map((reason) => <span key={reason}>{reason}</span>)}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className={styles.sectionBlock}>
              <div className={styles.sectionHeading}>
                <div><span>TRENDS</span><h2>容量・所要時間</h2></div>
                <p>失敗RunはCritical markerとして重ね、成功率だけでは見えない悪化傾向を確認します。</p>
              </div>
              <div className={styles.chartGrid}>
                <MetricLineChart
                  title="Backup Duration"
                  description="完了Runの所要時間推移"
                  series={durationSeries}
                  startAt={startAt}
                  endAt={endAt}
                  expectedIntervalSeconds={86_400}
                  aggregationLabel="Completed Run"
                  periodLabel={config.label}
                  unit="秒"
                  valueDigits={0}
                  markers={failureMarkers}
                  emptyDescription="完了したBackup Runが届くと所要時間を表示します。"
                />
                <MetricLineChart
                  title="Backup Size"
                  description="構造化Telemetryで取得できたBackup容量推移"
                  series={sizeSeries}
                  startAt={startAt}
                  endAt={endAt}
                  expectedIntervalSeconds={86_400}
                  aggregationLabel="Completed Run"
                  periodLabel={config.label}
                  unit=" GiB"
                  valueDigits={2}
                  markers={failureMarkers}
                  emptyDescription="sizeBytesを持つBackup Runが届くと容量推移を表示します。"
                />
              </div>
            </section>

            <section className={styles.sectionBlock}>
              <div className={styles.sectionHeading}>
                <div><span>RUN HISTORY</span><h2>実行履歴</h2></div>
                <p>Path・Bucket名・署名URL・stdout/stderrは保存せず、運用判断に必要な固定フィールドだけ表示します。</p>
              </div>
              {history.length === 0 ? (
                <div className={styles.emptyState}>選択期間にBackup Runはありません。</div>
              ) : (
                <div className={styles.tableShell}>
                  <table>
                    <thead><tr><th>日時</th><th>対象</th><th>結果</th><th>種類</th><th>容量</th><th>所要時間</th><th>Checksum</th><th>Remote</th><th>Failure</th></tr></thead>
                    <tbody>
                      {history.map((run) => (
                        <tr key={run.rowId}>
                          <td>{formatDateTime(run.completedAt ?? run.startedAt)}</td>
                          <td><strong>{run.backupTarget}</strong><small>{run.gameMode} / {run.hostDisplayName}</small></td>
                          <td><span className={`${styles.badge} ${run.outcome === "failed" ? styles.critical : run.outcome === "success" ? styles.healthy : styles.warning}`}>{outcomeLabels[run.outcome]}</span></td>
                          <td>{typeLabels[run.backupType]} / {run.destinationType.toUpperCase()}</td>
                          <td>{formatBytes(run.sizeBytes)}</td>
                          <td>{formatDuration(run.durationSeconds)}</td>
                          <td>{run.sha256Verified === true ? "Verified" : run.sha256Verified === false ? "Failed" : "—"}</td>
                          <td>{run.remoteSyncedAt ? formatDateTime(run.remoteSyncedAt) : "—"}</td>
                          <td>{run.failureCode ? failureLabels[run.failureCode] : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className={styles.notice}>
              <strong>読み取り専用・復元可能性を優先</strong>
              <p>Backup Centerから任意Shell、S3操作、バックアップ実行・削除・復元は行いません。Restore Readyは成功だけでは判定せず、Checksum・Retention・Restore Testを構造化Telemetryで確認できた場合だけReadyにします。</p>
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}
