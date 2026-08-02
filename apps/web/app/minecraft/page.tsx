import { AutoRefresh } from "../../components/auto-refresh";
import {
  getMinecraftOverview,
  type MinecraftOverallStatus,
  type MinecraftOverview,
} from "../../lib/minecraft";
import type { ContainerOverview } from "../../lib/monitoring";
import styles from "./minecraft.module.css";

export const dynamic = "force-dynamic";

const overallLabels: Record<MinecraftOverallStatus, string> = {
  operational: "正常稼働",
  degraded: "一部機能低下",
  partial_outage: "部分障害",
  major_outage: "重大障害",
  maintenance: "メンテナンス",
  unknown: "状態未取得",
};

const overallDescriptions: Record<MinecraftOverallStatus, string> = {
  operational: "公開接続、Velocity、ゲームサーバーがすべて正常です。",
  degraded: "接続は可能ですが、Voice Chatまたは公開設定に確認事項があります。",
  partial_outage: "公開側は応答していますが、バックエンド疎通に問題があります。",
  major_outage: "公開接続または主要コンテナが利用できません。",
  maintenance: "計画されたメンテナンス状態です。",
  unknown: "Agent 0.5.0からMinecraft Probeを受信すると表示されます。",
};

const statusClass: Record<MinecraftOverallStatus, string> = {
  operational: styles.operational,
  degraded: styles.degraded,
  partial_outage: styles.partialOutage,
  major_outage: styles.majorOutage,
  maintenance: styles.maintenance,
  unknown: styles.unknown,
};

function formatRelativeTime(timestamp: string | null): string {
  if (!timestamp) {
    return "未受信";
  }
  const ageSeconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(timestamp)) / 1_000),
  );
  if (ageSeconds < 60) {
    return `${ageSeconds}秒前`;
  }
  if (ageSeconds < 3_600) {
    return `${Math.floor(ageSeconds / 60)}分前`;
  }
  return `${Math.floor(ageSeconds / 3_600)}時間前`;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatContainerMemory(container: ContainerOverview | null): string {
  if (
    !container ||
    container.memoryUsageBytes === null ||
    container.memoryLimitBytes === null
  ) {
    return "未取得";
  }
  const percent =
    container.memoryLimitBytes > 0
      ? (container.memoryUsageBytes / container.memoryLimitBytes) * 100
      : 0;
  return `${formatBytes(container.memoryUsageBytes)} / ${formatBytes(container.memoryLimitBytes)} (${percent.toFixed(1)}%)`;
}

function formatContainerState(container: ContainerOverview | null): string {
  if (!container) {
    return "未受信";
  }
  return `${container.state} / ${container.health}`;
}

function formatContainerCPU(container: ContainerOverview | null): string {
  if (!container || container.cpuPercent === null) {
    return "未取得";
  }
  return `${container.cpuPercent.toFixed(2)}% / ${container.pids ?? "—"} PIDs`;
}

function formatPlayers(overview: MinecraftOverview | null): string {
  if (overview?.players.online === null || overview?.players.max === null) {
    return "— / —";
  }
  return `${overview.players.online} / ${overview.players.max}`;
}

function formatLatency(value: number | null | undefined): string {
  return value === null || value === undefined ? "未取得" : `${value} ms`;
}

function reachability(value: boolean | undefined): string {
  return value ? "応答あり" : "応答なし";
}

export default async function MinecraftPage() {
  let overview: MinecraftOverview | null = null;
  let hasDataError = false;

  try {
    overview = await getMinecraftOverview();
  } catch (error) {
    hasDataError = true;
    console.error("Minecraft総合状態の取得に失敗しました", error);
  }

  const status = overview?.status ?? "unknown";
  const velocity = overview?.velocity ?? null;
  const backend = overview?.backend ?? null;

  return (
    <main className="shell">
      <AutoRefresh intervalMs={15_000} />

      <aside className="sidebar">
        <a className="brand" href="/#top">
          <span>IV</span>
          <strong>IVRM Console</strong>
        </a>
        <nav aria-label="メインナビゲーション">
          <a href="/#top">概要</a>
          <a aria-current="page" href="/minecraft">
            Minecraft
          </a>
          <a href="/#hosts">ホスト</a>
          <a href="/#containers">コンテナ</a>
          <a href="/history">履歴グラフ</a>
        </nav>
        <div className="agent">
          <i
            className={
              status === "operational"
                ? "online"
                : status === "degraded" || status === "maintenance"
                  ? "stale"
                  : "error"
            }
          />
          Minecraft Overview
          <br />
          <small>{overallLabels[status]}</small>
        </div>
      </aside>

      <section className={`content ${styles.minecraftContent}`}>
        <header>
          <div>
            <h1>Minecraft生活サーバー</h1>
            <p>Velocity公開経路、バックエンド、Voice Chatを分離して確認します。</p>
          </div>
          <a className={styles.secondaryLink} href="/">
            システム概要へ戻る
          </a>
        </header>

        {hasDataError ? (
          <div className="empty error-panel" role="alert">
            <strong>Minecraft監視データを取得できませんでした</strong>
            <p>Supabase MigrationとVercel環境変数を確認してください。</p>
          </div>
        ) : (
          <>
            <section className={styles.hero} aria-label="Minecraft稼働状況">
              <article className={styles.overall}>
                <div className={styles.overallTop}>
                  <span>Minecraft総合状態</span>
                  <b className={`${styles.badge} ${statusClass[status]}`}>
                    {overallLabels[status]}
                  </b>
                </div>
                <h2>{overallLabels[status]}</h2>
                <p>{overallDescriptions[status]}</p>
              </article>
              <article>
                <span>オンライン</span>
                <strong>{formatPlayers(overview)}</strong>
                <small>公開Velocity応答値</small>
              </article>
              <article>
                <span>公開レイテンシ</span>
                <strong>{formatLatency(overview?.publicEndpoint.latencyMs)}</strong>
                <small>mc.ivrm.jp:25565</small>
              </article>
              <article>
                <span>最終確認</span>
                <strong>{formatRelativeTime(overview?.checkedAt ?? null)}</strong>
                <small>15秒間隔のAgent報告</small>
              </article>
            </section>

            <section className={styles.grid} aria-label="Minecraft構成要素">
              <article className={styles.card}>
                <div className={styles.cardHeader}>
                  <div>
                    <h3>公開接続</h3>
                    <p>利用者が接続するVelocityの正式エンドポイントです。</p>
                  </div>
                  <b
                    className={`${styles.badge} ${overview?.publicEndpoint.reachable ? styles.operational : styles.majorOutage}`}
                  >
                    {reachability(overview?.publicEndpoint.reachable)}
                  </b>
                </div>
                <div className={styles.details}>
                  <div>
                    <span>ENDPOINT</span>
                    <strong>mc.ivrm.jp:25565/tcp</strong>
                  </div>
                  <div>
                    <span>VERSION</span>
                    <strong>{overview?.publicEndpoint.version ?? "未取得"}</strong>
                  </div>
                  <div>
                    <span>PLAYERS</span>
                    <strong>{formatPlayers(overview)}</strong>
                  </div>
                  <div>
                    <span>LATENCY</span>
                    <strong>{formatLatency(overview?.publicEndpoint.latencyMs)}</strong>
                  </div>
                </div>
              </article>

              <article className={styles.card}>
                <div className={styles.cardHeader}>
                  <div>
                    <h3>Velocity</h3>
                    <p>Mojang認証と正規UUID・接続元情報の転送を担当します。</p>
                  </div>
                  <b
                    className={`${styles.badge} ${velocity?.status === "online" ? styles.operational : styles.majorOutage}`}
                  >
                    {velocity?.status === "online" ? "正常" : "要確認"}
                  </b>
                </div>
                <div className={styles.details}>
                  <div>
                    <span>CONTAINER</span>
                    <strong>ivrm-velocity</strong>
                  </div>
                  <div>
                    <span>STATE / HEALTH</span>
                    <strong>{formatContainerState(velocity)}</strong>
                  </div>
                  <div>
                    <span>CPU / PIDS</span>
                    <strong>{formatContainerCPU(velocity)}</strong>
                  </div>
                  <div>
                    <span>MEMORY</span>
                    <strong>{formatContainerMemory(velocity)}</strong>
                  </div>
                  <div>
                    <span>RESTART</span>
                    <strong>{velocity?.restartCount ?? "—"}</strong>
                  </div>
                  <div>
                    <span>OOM KILLED</span>
                    <strong>{velocity?.oomKilled ? "検知" : "なし"}</strong>
                  </div>
                </div>
              </article>

              <article className={styles.card}>
                <div className={styles.cardHeader}>
                  <div>
                    <h3>Minecraftバックエンド</h3>
                    <p>Docker内部ネットワークからのみVelocityが接続します。</p>
                  </div>
                  <b
                    className={`${styles.badge} ${overview?.backendProbe.reachable && backend?.status === "online" ? styles.operational : styles.partialOutage}`}
                  >
                    {overview?.backendProbe.reachable ? "内部疎通あり" : "内部疎通なし"}
                  </b>
                </div>
                <div className={styles.details}>
                  <div>
                    <span>CONTAINER</span>
                    <strong>mc-main</strong>
                  </div>
                  <div>
                    <span>STATE / HEALTH</span>
                    <strong>{formatContainerState(backend)}</strong>
                  </div>
                  <div>
                    <span>VERSION</span>
                    <strong>{overview?.backendProbe.version ?? "未取得"}</strong>
                  </div>
                  <div>
                    <span>INTERNAL LATENCY</span>
                    <strong>{formatLatency(overview?.backendProbe.latencyMs)}</strong>
                  </div>
                  <div>
                    <span>CPU / PIDS</span>
                    <strong>{formatContainerCPU(backend)}</strong>
                  </div>
                  <div>
                    <span>MEMORY</span>
                    <strong>{formatContainerMemory(backend)}</strong>
                  </div>
                </div>
              </article>

              <article className={styles.card}>
                <div className={styles.cardHeader}>
                  <div>
                    <h3>Simple Voice Chat</h3>
                    <p>ゲームTCPとは分離されたUDP公開設定を確認します。</p>
                  </div>
                  <b
                    className={`${styles.badge} ${overview?.voiceChat.published ? styles.operational : styles.degraded}`}
                  >
                    {overview?.voiceChat.published ? "公開設定あり" : "公開設定なし"}
                  </b>
                </div>
                <div className={styles.details}>
                  <div>
                    <span>ENDPOINT</span>
                    <strong>mc.ivrm.jp:24454/udp</strong>
                  </div>
                  <div>
                    <span>検査方式</span>
                    <strong>Docker Port Binding</strong>
                  </div>
                </div>
              </article>

              <article className={styles.securityCard}>
                <div className={styles.cardHeader}>
                  <div>
                    <h3>公開ポート安全性</h3>
                    <p>Velocityだけを公開し、MinecraftバックエンドTCPを直接公開しない構成です。</p>
                  </div>
                </div>
                <div className={styles.securityGrid}>
                  <div>
                    <span>VELOCITY 25565/TCP</span>
                    <strong
                      className={
                        overview?.networkPolicy.proxyPortPublished
                          ? styles.good
                          : styles.bad
                      }
                    >
                      {overview?.networkPolicy.proxyPortPublished
                        ? "公開済み"
                        : "未公開"}
                    </strong>
                  </div>
                  <div>
                    <span>MC-MAIN 25565/TCP</span>
                    <strong
                      className={
                        overview?.networkPolicy.backendDirectAccessBlocked
                          ? styles.good
                          : styles.bad
                      }
                    >
                      {overview?.networkPolicy.backendDirectAccessBlocked
                        ? "外部非公開"
                        : "直接公開を検知"}
                    </strong>
                  </div>
                  <div>
                    <span>廃止ポート</span>
                    <strong className={styles.good}>25566は使用しない</strong>
                  </div>
                </div>
              </article>
            </section>

            <section className={styles.note}>
              <strong>読み取り専用</strong>
              <p>
                この画面は状態確認専用です。RCON、Docker Socket、forwarding.secret、PCF
                secret、プレイヤーIPは収集・表示しません。起動・停止・再起動などの操作は、認証・RBAC・監査ログ基盤の完成後に別タスクで追加します。
              </p>
            </section>
          </>
        )}
      </section>
    </main>
  );
}
