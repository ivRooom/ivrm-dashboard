import { AutoRefresh } from "../../components/auto-refresh";
import { getConsoleSession, hasConsoleRole } from "../../lib/console-auth";
import {
  INCIDENT_RANGE_CONFIG,
  parseIncidentRange,
  type IncidentRange,
} from "../../lib/unified-incidents";
import {
  getReliabilitySnapshot,
  type ReliabilityHealth,
} from "../../lib/reliability";
import { getReliabilityMaintenanceTargets } from "../../lib/reliability-maintenance";
import { ReliabilityBurnHistoryPanel } from "./burn-history-panel";
import { ReliabilityBurnRatePanel } from "./burn-rate-panel";
import { ReliabilityMaintenancePanel } from "./maintenance-panel";
import { ReliabilityNotificationPanel } from "./notification-panel";
import { ReliabilityServiceCard } from "./service-card";
import { ReliabilitySloPanel } from "./slo-panel";
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

function indicatorClass(loadError: boolean, health: ReliabilityHealth | undefined): string {
  if (loadError || !health || health === "critical" || health === "unknown") return "error";
  if (health === "degraded" || health === "disabled") return "stale";
  return "online";
}

export default async function ReliabilityPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const range = parseIncidentRange(first(query.range));
  const policyOutcome = first(query.policy);
  const maintenanceOutcome = first(query.maintenance);
  const [reliabilityResult, sessionResult] = await Promise.allSettled([
    getReliabilitySnapshot(range),
    getConsoleSession(),
  ]);

  const data = reliabilityResult.status === "fulfilled" ? reliabilityResult.value : null;
  const loadError = reliabilityResult.status === "rejected";
  const canManageSlo =
    sessionResult.status === "fulfilled" && hasConsoleRole(sessionResult.value, "administrator");

  if (reliabilityResult.status === "rejected") {
    console.error("Reliability Centerの取得に失敗しました", reliabilityResult.reason);
  }
  if (sessionResult.status === "rejected") {
    console.error("Reliability CenterのSession取得に失敗しました", sessionResult.reason);
  }

  const maintenanceTargetsResult = canManageSlo
    ? await Promise.allSettled([getReliabilityMaintenanceTargets()])
    : null;
  const maintenanceTargets =
    maintenanceTargetsResult?.[0]?.status === "fulfilled"
      ? maintenanceTargetsResult[0].value
      : null;
  const maintenanceTargetsDataAvailable =
    !canManageSlo || maintenanceTargetsResult?.[0]?.status === "fulfilled";
  if (
    canManageSlo &&
    maintenanceTargetsResult?.[0]?.status === "rejected"
  ) {
    console.error(
      "Reliability Maintenance対象一覧の取得に失敗しました",
      maintenanceTargetsResult[0].reason,
    );
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
          <a href="/capacity">キャパシティ</a><a href={`/history?range=${range}`}>履歴グラフ</a>
        </nav>
        <div className="agent">
          <i className={indicatorClass(loadError, data?.overall.health)} />
          Reliability Center<br />
          <small>{loadError ? "取得エラー" : data ? healthLabels[data.overall.health] : "Loading"}</small>
        </div>
      </aside>

      <section className={`content ${styles.content}`}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>RELIABILITY / SLO / BURN RATE / HISTORY / MAINTENANCE</p>
            <h1>Service Reliability Center</h1>
            <p>Host・Container・Backup・Notificationを横断し、Raw Incident、明示SLO、Burn Rate、履歴、スコープ付き計画停止から稼働品質とError Budgetを確認します。</p>
          </div>
          <div className={styles.actions}>
            <a href={`/incidents?range=${range}`}>Incident Center</a>
            <a href="/capacity">Capacity Forecast</a>
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
                <span className={styles.eyebrow}>OVERALL HEALTH / RAW</span>
                <strong className={styles[data.overall.health]}>{healthLabels[data.overall.health]}</strong>
                <p>{data.overall.exactCoverage ? "Raw Incidentから選択期間のKnown Downtimeを確定できます。" : "未確定開始時刻または欠損データがあるためRaw比率は上限値です。"}</p>
              </article>
              <article className={styles.metric}><span>INCIDENT-FREE / RAW</span><strong>{ratio(data.overall.incidentFreeRatio, data.overall.exactCoverage)}</strong><small>{INCIDENT_RANGE_CONFIG[range].label}</small></article>
              <article className={styles.metric}><span>KNOWN DOWNTIME / RAW</span><strong>{duration(data.overall.knownDowntimeSeconds)}</strong><small>計画停止でも隠さない</small></article>
              <article className={styles.metric}><span>ACTIVE</span><strong>{data.overall.activeIncidentCount}</strong><small>重大 {data.overall.activeCriticalCount}</small></article>
              <article className={styles.metric}><span>MEDIAN RECOVERY</span><strong>{duration(data.overall.medianRecoverySeconds)}</strong><small>Recovered {data.overall.recoveredIncidentCount}</small></article>
              <article className={styles.metric}><span>LONGEST RECOVERY</span><strong>{duration(data.overall.longestRecoverySeconds)}</strong><small>選択期間内の最大復旧時間</small></article>
            </section>
            {!data.backupDataAvailable || !data.notificationDataAvailable ? (
              <div className={styles.coverage}>一部データソースを取得できないため、取得できたサービスだけでRaw Reliabilityを継続表示しています。</div>
            ) : null}

            <ReliabilityMaintenancePanel
              canManage={canManageSlo}
              dataAvailable={data.maintenanceDataAvailable}
              generatedAt={data.generatedAt}
              outcome={maintenanceOutcome}
              range={range}
              targets={maintenanceTargets}
              targetsDataAvailable={maintenanceTargetsDataAvailable}
              windows={data.maintenanceWindows}
            />

            <ReliabilitySloPanel
              budgets={data.sloBudgets}
              canManage={canManageSlo}
              maintenanceDataAvailable={data.maintenanceDataAvailable}
              outcome={policyOutcome}
              policyDataAvailable={data.sloPolicyDataAvailable}
              range={range}
            />

            <ReliabilityBurnRatePanel burnRates={data.burnRates} />
            <ReliabilityBurnHistoryPanel
              generatedAt={data.generatedAt}
              history={data.burnHistory}
              reconciler={data.burnReconciler}
            />

            <section>
              <div className={styles.sectionTitle}><div><span>SERVICE SCORECARDS / RAW</span><h2>サービス別信頼性</h2></div><p>現在HealthとRaw Incident実績を表示します。Maintenance WindowはこのScorecardから障害を消さず、SLO計算レイヤーだけに適用されます。</p></div>
              <div className={styles.serviceGrid}>{data.services.map((service) => <ReliabilityServiceCard key={service.id} service={service} range={range} />)}</div>
            </section>
            <ReliabilityNotificationPanel data={data} />
            <section className={styles.notice}><strong>Raw Reliability / SLO / Burn Rateについて</strong><p>Raw Incident-free ratio / Known DowntimeはMaintenance Windowの有無に関係なく実測障害を保持します。SLOとBurn RateだけがIncidentごとに適用可能な計画停止とのIntersectionを除外します。Burn Rateは1h / 6h / 24hを独立評価し、Coverage不足では障害なし・復旧済みと推測しません。履歴は5分粒度で30日保持し、Alert判定には利用しません。</p></section>
          </>
        )}
      </section>
    </main>
  );
}