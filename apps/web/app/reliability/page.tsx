import { AutoRefresh } from "../../components/auto-refresh";
import {
  INCIDENT_RANGE_CONFIG,
  parseIncidentRange,
  type IncidentRange,
} from "../../lib/unified-incidents";
import {
  getReliabilitySnapshot,
  type ReliabilityHealth,
} from "../../lib/reliability";
import { ReliabilityNotificationPanel } from "./notification-panel";
import { ReliabilityServiceCard } from "./service-card";
import styles from "./reliability.module.css";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const healthLabels: Record<ReliabilityHealth, string> = {
  operational: "Operational",
  degraded: "Degraded",
  critical: "Major Outage",
  disabled: "Disabled",
  unknown: "Unknown",
};

function first(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function duration(seconds: number | null): string {
  if (seconds === null) return "対象外";
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間 ${Math.floor((seconds % 3600) / 60)}分`;
  return `${Math.floor(seconds / 86400)}日 ${Math.floor((seconds % 86400) / 3600)}時間`;
}

function ratio(value: number, exact: boolean): string {
  const text = `${(value * 100).toFixed(value >= 0.999 ? 3 : 2)}%`;
  return exact ? text : `≤ ${text}`;
}

export default async function ReliabilityPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const range = parseIncidentRange(first(query.range));
  let data = null;
  let loadError = false;

  try {
    data = await getReliabilitySnapshot(range);
  } catch (error) {
    loadError = true;
    console.error("Reliability Centerの取得に失敗しました", error);
  }

  return (
    <main className="shell">
      <AutoRefresh intervalMs={30_000} />
      <aside className="sidebar">
        <a className="brand" href="/#top"><span>IV</span><strong>IVRM Console</strong></a>
        <nav aria-label="メインナビゲーション">
          <a href="/#top">概要</a><a href="/minecraft">Minecraft</a><a href="/hosts">ホスト</a>
          <a href="/containers">コンテナ</a><a href={`/incidents?range=${range}`}>インシデント</a>
          <a href={`/backups?range=${range}`}>バックアップ</a><a href="/notifications">通知</a>
          <a aria-current="page" href={`/reliability?range=${range}`}>信頼性</a>
          <a href={`/history?range=${range}`}>履歴グラフ</a>
        </nav>
        <div className="agent">
          <i className={loadError ? "error" : data?.overall.health === "critical" ? "error" : data?.overall.health === "degraded" ? "stale" : "online"} />
          Reliability Center<br />
          <small>{loadError ? "取得エラー" : data ? healthLabels[data.overall.health] : "Loading"}</small>
        </div>
      </aside>

      <section className={`content ${styles.content}`}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>RELIABILITY / HEALTH / RECOVERY</p>
            <h1>Service Reliability Center</h1>
            <p>Host・Container・Backup・Notificationを横断し、現在状態と構造化Incidentから証明できる稼働品質を確認します。</p>
          </div>
          <div className={styles.actions}>
            <a href={`/incidents?range=${range}`}>Incident Center</a>
            <a href="/notifications">Notification Center</a>
          </div>
        </header>

        <nav className={styles.periods} aria-label="信頼性集計期間">
          {(Object.keys(INCIDENT_RANGE_CONFIG) as IncidentRange[]).map((candidate) => (
            <a key={candidate} aria-current={candidate === range ? "page" : undefined} href={`/reliability?range=${candidate}`}>
              {INCIDENT_RANGE_CONFIG[candidate].label}
            </a>
          ))}
        </nav>

        {loadError || !data ? (
          <div className="empty error-panel" role="alert"><strong>Reliability情報を取得できませんでした</strong><p>Incident / Backup / Notificationのデータ接続を確認してください。</p></div>
        ) : (
          <>
            <section className={styles.overall} aria-label="Overall Reliability">
              <article className={styles.hero}>
                <span className={styles.eyebrow}>OVERALL HEALTH</span>
                <strong className={styles[data.overall.health]}>{healthLabels[data.overall.health]}</strong>
                <p>{data.overall.exactCoverage ? "選択期間のKnown Downtimeを確定できます。" : "未確定開始時刻または欠損データがあるため比率は上限値です。"}</p>
              </article>
              <article className={styles.metric}><span>INCIDENT-FREE</span><strong>{ratio(data.overall.incidentFreeRatio, data.overall.exactCoverage)}</strong><small>{INCIDENT_RANGE_CONFIG[range].label}</small></article>
              <article className={styles.metric}><span>KNOWN DOWNTIME</span><strong>{duration(data.overall.knownDowntimeSeconds)}</strong><small>重複時間はUnion</small></article>
              <article className={styles.metric}><span>ACTIVE</span><strong>{data.overall.activeIncidentCount}</strong><small>重大 {data.overall.activeCriticalCount}</small></article>
              <article className={styles.metric}><span>MEDIAN RECOVERY</span><strong>{duration(data.overall.medianRecoverySeconds)}</strong><small>Recovered {data.overall.recoveredIncidentCount}</small></article>
            </section>

            {!data.backupDataAvailable || !data.notificationDataAvailable ? (
              <div className={styles.coverage}>一部データソースを取得できないため、取得できたサービスだけで継続表示しています。</div>
            ) : null}

            <section>
              <div className={styles.sectionTitle}><div><span>SERVICE SCORECARDS</span><h2>サービス別信頼性</h2></div><p>SLO値は未設定のため仮定せず、実Incidentだけを集計します。</p></div>
              <div className={styles.serviceGrid}>{data.services.map((service) => <ReliabilityServiceCard key={service.id} service={service} />)}</div>
            </section>

            <ReliabilityNotificationPanel data={data} />

            <section className={styles.notice}><strong>Incident-free ratioについて</strong><p>Recovery済みIncidentと開始時刻を証明できるActive IncidentだけをDowntimeへ含めます。複数障害の重複時間は1回だけ数えます。開始時刻不明のActive障害がある場合は実際の比率が表示値以下となるため「≤」で示します。</p></section>
          </>
        )}
      </section>
    </main>
  );
}
