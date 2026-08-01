import { AutoRefresh } from "../../components/auto-refresh";
import { MetricLineChart } from "../../components/metric-line-chart";
import { getContainerMetricHistory } from "../../lib/history";
import styles from "./history.module.css";

export const dynamic = "force-dynamic";

const HOURS = 24;
const BUCKET_SECONDS = 300;

function formatPeriod(timestamp: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo",
  }).format(new Date(timestamp));
}

export default async function HistoryPage() {
  const endAt = new Date();
  const startAt = new Date(endAt.getTime() - HOURS * 60 * 60 * 1_000);
  let hasDataError = false;
  let history = [] as Awaited<ReturnType<typeof getContainerMetricHistory>>;

  try {
    history = await getContainerMetricHistory(HOURS, BUCKET_SECONDS);
  } catch {
    hasDataError = true;
    console.error("監視履歴の取得に失敗しました");
  }

  const cpuSeries = history.map((item) => ({
    id: `${item.hostId}:${item.containerName}`,
    label: `${item.containerName} / ${item.hostDisplayName}`,
    points: item.points.map((point) => ({
      timestamp: point.timestamp,
      value: point.cpuPercent,
    })),
  }));
  const memorySeries = history.map((item) => ({
    id: `${item.hostId}:${item.containerName}`,
    label: `${item.containerName} / ${item.hostDisplayName}`,
    points: item.points.map((point) => ({
      timestamp: point.timestamp,
      value: point.memoryPercent,
    })),
  }));
  const sampleCount = history.reduce(
    (total, item) =>
      total + item.points.reduce((sum, point) => sum + point.sampleCount, 0),
    0,
  );

  return (
    <main className="shell">
      <AutoRefresh />

      <aside className="sidebar">
        <a className="brand" href="/#top">
          <span>IV</span>
          <strong>IVRM Console</strong>
        </a>
        <nav aria-label="メインナビゲーション">
          <a href="/#top">概要</a>
          <a href="/#hosts">ホスト</a>
          <a href="/#containers">コンテナ</a>
          <a aria-current="page" href="/history">
            履歴グラフ
          </a>
        </nav>
        <div className="agent">
          <i className={hasDataError ? "error" : "online"} />
          Metrics History
          <br />
          <small>{hasDataError ? "取得エラー" : "5分集約"}</small>
        </div>
      </aside>

      <section className={`content ${styles.historyContent}`}>
        <header>
          <div>
            <h1>監視履歴</h1>
            <p>DockerコンテナのCPU・メモリ推移を時系列で確認できます。</p>
          </div>
          <a className={styles.secondaryLink} href="/">
            現在値へ戻る
          </a>
        </header>

        <section className={styles.summary} aria-label="履歴表示条件">
          <div>
            <span>表示期間</span>
            <strong>直近24時間</strong>
          </div>
          <div>
            <span>集約粒度</span>
            <strong>5分平均</strong>
          </div>
          <div>
            <span>コンテナ</span>
            <strong>{hasDataError ? "—" : history.length}</strong>
          </div>
          <div>
            <span>元サンプル</span>
            <strong>
              {hasDataError ? "—" : sampleCount.toLocaleString("ja-JP")}
            </strong>
          </div>
        </section>

        <div className={styles.toolbar}>
          <div className={styles.periodSelector} aria-label="表示期間">
            <span className={styles.active}>24時間</span>
            <span aria-disabled="true">7日（準備中）</span>
            <span aria-disabled="true">30日（準備中）</span>
          </div>
          <small>
            {formatPeriod(startAt.toISOString())}〜
            {formatPeriod(endAt.toISOString())}
          </small>
        </div>

        {hasDataError ? (
          <div className="empty error-panel" role="alert">
            <strong>監視履歴を取得できませんでした</strong>
            <p>Supabaseの履歴RPCとVercel環境変数を確認してください。</p>
          </div>
        ) : (
          <section className={styles.chartGrid} aria-label="Dockerリソース履歴">
            <MetricLineChart
              title="CPU使用率"
              description="各コンテナの5分平均です。欠損区間は線を接続しません。"
              series={cpuSeries}
              startAt={startAt.toISOString()}
              endAt={endAt.toISOString()}
              expectedIntervalSeconds={BUCKET_SECONDS}
              unit="%"
            />
            <MetricLineChart
              title="メモリ使用率"
              description="使用量をコンテナのメモリ上限で割った5分平均です。"
              series={memorySeries}
              startAt={startAt.toISOString()}
              endAt={endAt.toISOString()}
              expectedIntervalSeconds={BUCKET_SECONDS}
              unit="%"
              maximum={100}
            />
          </section>
        )}

        <section className={styles.note}>
          <strong>データ保持について</strong>
          <p>
            現在は既存の生データから直近24時間を5分単位で集約しています。7日・30日表示は、1分・5分・1時間ロールアップと自動削除処理を追加してから有効化します。
          </p>
        </section>
      </section>
    </main>
  );
}
