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

function overallTone(status: MinecraftOverallStatus): ConsoleTone {
  if (status === "operational") return "success";
  if (status === "degraded") return "warning";
  if (status === "partial_outage" || status === "major_outage") return "danger";
  if (status === "maintenance") return "maintenance";
  return "neutral";
}

function formatRelativeTime(timestamp: string | null): string {
  if (!timestamp) return "未受信";
  const ageSeconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(timestamp)) / 1_000),
  );
  if (ageSeconds < 60) return `${ageSeconds}秒前`;
  if (ageSeconds < 3_600) return `${Math.floor(ageSeconds / 60)}分前`;
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
  if (!container) return "未受信";
  return `${container.state} / ${container.health}`;
}

function formatContainerCPU(container: ContainerOverview | null): string {
  if (!container || container.cpuPercent === null) return "未取得";
  return `${container.cpuPercent.toFixed(2)}% / ${container.pids ?? "—"} PIDs`;
}

function formatPlayers(overview: MinecraftOverview | null): string {
  const online = overview?.players.online;
  const maximum = overview?.players.max;
  if (
    online === null ||
    online === undefined ||
    maximum === null ||
    maximum === undefined
  ) {
    return "— / —";
  }
  return `${online} / ${maximum}`;
}

function formatLatency(value: number | null | undefined): string {
  return value === null || value === undefined ? "未取得" : `${value} ms`;
}

function reachability(value: boolean | undefined): string {
  return value ? "応答あり" : "応答なし";
}

function isStableContainer(container: ContainerOverview | null): boolean {
  return (
    container !== null &&
    ["online", "standby", "maintenance"].includes(container.status)
  );
}

function stableContainerLabel(container: ContainerOverview | null): string {
  if (container?.status === "maintenance") return "メンテナンス";
  if (container?.status === "standby") return "待機中";
  return isStableContainer(container) ? "正常" : "要確認";
}

function containerTone(container: ContainerOverview | null): ConsoleTone {
  if (!container) return "neutral";
  if (container.status === "maintenance") return "maintenance";
  if (container.status === "online") return "success";
  if (container.status === "standby") return "info";
  if (container.status === "stale") return "warning";
  return "danger";
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
  const backendStable = isStableContainer(backend);
  const backendReachable = overview?.backendProbe.reachable === true;

  return (
    <>
      <AutoRefresh intervalMs={15_000} />
      <PageContent className={styles.content}>
        <PageHeader
          className={styles.pageHeader}
          eyebrow="MINECRAFT OPERATIONS"
          title="Minecraft生活サーバー"
          description="Velocity公開経路、バックエンド、Voice Chatを分離して確認します。"
          actions={<ActionLink href="/">Overviewへ戻る</ActionLink>}
        />

        {hasDataError ? (
          <StatePanel title="Minecraft監視データを取得できませんでした" variant="error">
            Supabase MigrationとVercel環境変数を確認してください。
          </StatePanel>
        ) : (
          <>
            <section className={styles.statusSection} aria-label="Minecraft稼働状況">
              <article className={styles.overallPanel}>
                <div className={styles.overallTop}>
                  <span>Minecraft総合状態</span>
                  <StatusBadge tone={overallTone(status)}>{overallLabels[status]}</StatusBadge>
                </div>
                <h2>{overallLabels[status]}</h2>
                <p>{overallDescriptions[status]}</p>
              </article>

              <MetricGrid className={styles.metricGrid} label="Minecraft現在値">
                <MetricCard
                  label="ONLINE PLAYERS"
                  value={formatPlayers(overview)}
                  detail="公開Velocity応答値"
                />
                <MetricCard
                  label="PUBLIC LATENCY"
                  value={formatLatency(overview?.publicEndpoint.latencyMs)}
                  detail="mc.ivrm.jp:25565"
                />
                <MetricCard
                  label="LAST CHECK"
                  value={formatRelativeTime(overview?.checkedAt ?? null)}
                  detail="15秒間隔のAgent報告"
                />
              </MetricGrid>
            </section>

            <section aria-label="Minecraft構成要素">
              <SectionHeader
                eyebrow="SERVICE COMPONENTS"
                title="接続経路とContainer状態"
                description="公開経路・Proxy・ゲームBackend・Voice Chatを個別に確認します。"
              />
              <div className={styles.grid}>
                <article className={styles.card}>
                  <div className={styles.cardHeader}>
                    <div>
                      <h3>公開接続</h3>
                      <p>利用者が接続するVelocityの正式エンドポイントです。</p>
                    </div>
                    <StatusBadge tone={overview?.publicEndpoint.reachable ? "success" : "danger"}>
                      {reachability(overview?.publicEndpoint.reachable)}
                    </StatusBadge>
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
                    <StatusBadge tone={containerTone(velocity)}>
                      {stableContainerLabel(velocity)}
                    </StatusBadge>
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
                    <StatusBadge
                      tone={!backendReachable ? "danger" : backendStable ? containerTone(backend) : "danger"}
                    >
                      {!backendReachable
                        ? "内部疎通なし"
                        : backendStable
                          ? stableContainerLabel(backend)
                          : "状態要確認"}
                    </StatusBadge>
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
                    <StatusBadge tone={overview?.voiceChat.published ? "success" : "warning"}>
                      {overview?.voiceChat.published ? "公開設定あり" : "公開設定なし"}
                    </StatusBadge>
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
                      <StatusBadge tone={overview?.networkPolicy.proxyPortPublished ? "success" : "danger"}>
                        {overview?.networkPolicy.proxyPortPublished ? "公開済み" : "未公開"}
                      </StatusBadge>
                    </div>
                    <div>
                      <span>MC-MAIN 25565/TCP</span>
                      <StatusBadge
                        tone={overview?.networkPolicy.backendDirectAccessBlocked ? "success" : "danger"}
                      >
                        {overview?.networkPolicy.backendDirectAccessBlocked
                          ? "外部非公開"
                          : "直接公開を検知"}
                      </StatusBadge>
                    </div>
                    <div>
                      <span>廃止ポート</span>
                      <StatusBadge tone="success">25566は使用しない</StatusBadge>
                    </div>
                  </div>
                </article>
              </div>
            </section>

            <StatePanel title="読み取り専用" variant="info">
              この画面は状態確認専用です。RCON、Docker Socket、forwarding.secret、PCF secret、プレイヤーIPは収集・表示しません。起動・停止・再起動などの操作は、認証・RBAC・監査ログ基盤の完成後に別タスクで追加します。
            </StatePanel>
          </>
        )}
      </PageContent>
    </>
  );
}
