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
import {
  getMinecraftLiveMetrics,
  type LiveMetricSeries,
  type MinecraftLiveMetrics,
  type LiveRangeId,
} from "../../lib/minecraft-live-metrics";
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

function formatLivePct(value: number | null): string {
  return value === null ? "未取得" : `${value.toFixed(1)}%`;
}

function LiveChart({
  label,
  series,
  metric,
  max = 100,
  caption,
}: {
  label: string;
  series: LiveMetricSeries[];
  metric: "cpu" | "memory";
  max?: number;
  caption?: string;
}) {
  const width = 600;
  const height = 150;
  const padL = 34;
  const padR = 8;
  const padT = 10;
  const padB = 10;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const runs = series.flatMap((s) => {
    const points = s[metric];
    const segments: { points: string; color: string; id: string }[] = [];
    let current: string[] = [];
    const flush = () => {
      if (current.length > 1) {
        segments.push({
          points: current.join(" "),
          color: s.color,
          id: `${s.key}-${segments.length}`,
        });
      }
      current = [];
    };
    points.forEach((value, index) => {
      if (value === null) {
        flush();
        return;
      }
      const x = padL + (index / Math.max(1, points.length - 1)) * innerW;
      const y =
        padT + innerH - (Math.min(max, Math.max(0, value)) / max) * innerH;
      current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    });
    flush();
    return segments;
  });
  return (
    <figure className={styles.liveChart}>
      <figcaption>
        {label}
        {caption ? `（${caption}）` : ""}
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        {[0, max / 2, max].map((value) => {
          const y = padT + innerH - (value / max) * innerH;
          return (
            <g key={value}>
              <line
                x1={padL}
                y1={y}
                x2={width - padR}
                y2={y}
                className={styles.liveGridLine}
              />
              <text x={4} y={y + 4} className={styles.liveAxisLabel}>
                {value}
              </text>
            </g>
          );
        })}
        {runs.map((run) => (
          <polyline
            key={run.id}
            points={run.points}
            fill="none"
            stroke={run.color}
            strokeWidth={2}
          />
        ))}
      </svg>
    </figure>
  );
}

function liveStateBadge(state: string | undefined) {
  if (state === "running") return <StatusBadge tone="success">稼働中</StatusBadge>;
  if (state === "stopped") return <StatusBadge tone="neutral">停止中</StatusBadge>;
  return <StatusBadge tone="neutral">未取得</StatusBadge>;
}

type MinecraftPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const LIVE_RANGES = [
  { id: "30m", label: "30分" },
  { id: "2h", label: "2時間" },
  { id: "24h", label: "24時間" },
] as const;

function jstDateString(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

export default async function MinecraftPage({ searchParams }: MinecraftPageProps) {
  const params = await searchParams;
  const liveRange: LiveRangeId =
    params.range === "2h" || params.range === "24h" ? params.range : "30m";
  const liveRangeLabel =
    LIVE_RANGES.find((range) => range.id === liveRange)?.label ?? "30分";
  let overview: MinecraftOverview | null = null;
  let hasDataError = false;

  try {
    overview = await getMinecraftOverview();
  } catch (error) {
    hasDataError = true;
    console.error("Minecraft総合状態の取得に失敗しました", error);
  }

  let liveMetrics: MinecraftLiveMetrics | null = null;
  try {
    liveMetrics = await getMinecraftLiveMetrics();
  } catch (error) {
    console.error("Minecraftライブメトリクスの取得に失敗しました", error);
  }

  const liveRangeData = liveMetrics?.ranges[liveRange] ?? { series: [], tps: [] };
  const tpsValues = liveRangeData.tps.filter((v): v is number => v !== null);
  const tpsSeries: LiveMetricSeries[] =
    liveRangeData.tps.length >= 2
      ? [
          {
            key: "game",
            label: "TPS",
            color: "#a78bfa",
            cpu: liveRangeData.tps,
            memory: [],
          },
        ]
      : [];
  const tpsMax = Math.max(20, ...tpsValues);

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

            {liveMetrics ? (
              <section aria-label="Minecraftライブメトリクス">
                <SectionHeader
                  eyebrow="LIVE METRICS"
                  title="ライブメトリクス（OCIホスト）"
                  description="status.ivrm.jp と同じ秒単位の収集データを表示します（15秒ごとに自動更新）。"
                />
                <div className={styles.grid}>
                  <article className={styles.card}>
                    <div className={styles.cardHeader}>
                      <div>
                        <h3>生活サーバー</h3>
                        <p>mc-main コンテナの現在の使用率です。</p>
                      </div>
                      {liveStateBadge(liveMetrics.main?.state)}
                    </div>
                    <div className={styles.details}>
                      <div>
                        <span>CPU</span>
                        <strong>{formatLivePct(liveMetrics.main?.cpuPct ?? null)}</strong>
                      </div>
                      <div>
                        <span>メモリ</span>
                        <strong>{formatLivePct(liveMetrics.main?.memPct ?? null)}</strong>
                      </div>
                    </div>
                  </article>
                  <article className={styles.card}>
                    <div className={styles.cardHeader}>
                      <div>
                        <h3>資源サーバー</h3>
                        <p>mc-resource コンテナの現在の使用率です。</p>
                      </div>
                      {liveStateBadge(liveMetrics.resource?.state)}
                    </div>
                    <div className={styles.details}>
                      <div>
                        <span>CPU</span>
                        <strong>
                          {formatLivePct(liveMetrics.resource?.cpuPct ?? null)}
                        </strong>
                      </div>
                      <div>
                        <span>メモリ</span>
                        <strong>
                          {formatLivePct(liveMetrics.resource?.memPct ?? null)}
                        </strong>
                      </div>
                    </div>
                  </article>
                  <article className={styles.card}>
                    <div className={styles.cardHeader}>
                      <div>
                        <h3>ホスト全体</h3>
                        <p>OCI ホスト全体の使用率です。</p>
                      </div>
                      <StatusBadge tone="info">OCI</StatusBadge>
                    </div>
                    <div className={styles.details}>
                      <div>
                        <span>CPU</span>
                        <strong>{formatLivePct(liveMetrics.host?.cpuPct ?? null)}</strong>
                      </div>
                      <div>
                        <span>メモリ</span>
                        <strong>{formatLivePct(liveMetrics.host?.memPct ?? null)}</strong>
                      </div>
                    </div>
                  </article>
                  {liveMetrics.game ? (
                    <article className={styles.card}>
                      <div className={styles.cardHeader}>
                        <div>
                          <h3>ゲーム（生活サーバー）</h3>
                          <p>TPS とティック時間（MSPT）です。</p>
                        </div>
                        <StatusBadge tone="info">TPS</StatusBadge>
                      </div>
                      <div className={styles.details}>
                        <div>
                          <span>TPS（1分平均）</span>
                          <strong>
                            {liveMetrics.game.tps1m?.toFixed(1) ?? "未取得"}
                          </strong>
                        </div>
                        <div>
                          <span>TPS（5分 / 15分）</span>
                          <strong>
                            {liveMetrics.game.tps5m?.toFixed(1) ?? "—"} /{" "}
                            {liveMetrics.game.tps15m?.toFixed(1) ?? "—"}
                          </strong>
                        </div>
                        <div>
                          <span>MSPT 中央値 / p95</span>
                          <strong>
                            {liveMetrics.game.msptMedian1m?.toFixed(2) ?? "—"}ms /{" "}
                            {liveMetrics.game.msptP951m?.toFixed(2) ?? "—"}ms
                          </strong>
                        </div>
                        <div>
                          <span>プレイヤー</span>
                          <strong>
                            {liveMetrics.players?.online ?? "未取得"}
                            {liveMetrics.players?.max != null
                              ? ` / ${liveMetrics.players.max} 人`
                              : " 人"}
                          </strong>
                        </div>
                      </div>
                    </article>
                  ) : null}
                  {liveRangeData.series.length > 0 ? (
                    <article className={`${styles.card} ${styles.liveChartCard}`}>
                      <nav className={styles.liveRangeNav} aria-label="表示範囲">
                        {LIVE_RANGES.map((range) => (
                          <a
                            key={range.id}
                            href={`/minecraft?range=${range.id}`}
                            className={
                              range.id === liveRange
                                ? styles.liveRangeLinkActive
                                : styles.liveRangeLink
                            }
                            aria-current={range.id === liveRange ? "page" : undefined}
                          >
                            {range.label}
                          </a>
                        ))}
                      </nav>
                      <LiveChart
                        label="CPU使用率"
                        series={liveRangeData.series}
                        metric="cpu"
                        caption={liveRangeLabel}
                      />
                      <LiveChart
                        label="メモリ使用率"
                        series={liveRangeData.series}
                        metric="memory"
                        caption={liveRangeLabel}
                      />
                      {tpsSeries.length > 0 ? (
                        <LiveChart
                          label="TPS（生活サーバー）"
                          series={tpsSeries}
                          metric="cpu"
                          max={tpsMax}
                          caption={liveRangeLabel}
                        />
                      ) : null}
                      <div className={styles.liveLegend}>
                        {liveRangeData.series.map((s) => (
                          <span key={s.key}>
                            <i style={{ background: s.color }} />
                            {s.label}
                          </span>
                        ))}
                      </div>
                    </article>
                  ) : null}
                  <article className={styles.card}>
                    <div className={styles.cardHeader}>
                      <div>
                        <h3>日次レポート・蓄積データ</h3>
                        <p>毎朝 07:05 に前日分を集計しています。</p>
                      </div>
                      <StatusBadge tone="info">CSV</StatusBadge>
                    </div>
                    {liveMetrics.reports.length > 0 ? (
                      <ul className={styles.liveReportList}>
                        {liveMetrics.reports.map((report) => (
                          <li key={report.date}>
                            <a href={report.url} target="_blank" rel="noreferrer">
                              {report.date} のレポート
                            </a>
                            <span>
                              TPS 平均 {report.tpsAvg?.toFixed(1) ?? "—"} ・ ホストCPU
                              最大 {report.cpuMaxHost?.toFixed(0) ?? "—"}%
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>まだレポートがありません。</p>
                    )}
                    <p className={styles.liveCsvLinks}>
                      CSV（10秒間隔）:{" "}
                      <a
                        href={`https://status.ivrm.jp/data/metrics-${jstDateString(0)}.csv`}
                      >
                        今日
                      </a>{" "}
                      ・{" "}
                      <a
                        href={`https://status.ivrm.jp/data/metrics-${jstDateString(-1)}.csv`}
                      >
                        昨日
                      </a>{" "}
                      ・ <a href="https://status.ivrm.jp/reports/">レポート一覧</a>
                    </p>
                  </article>
                </div>
              </section>
            ) : null}

            <StatePanel title="読み取り専用" variant="info">
              この画面は状態確認専用です。RCON、Docker Socket、forwarding.secret、PCF secret、プレイヤーIPは収集・表示しません。起動・停止・再起動などの操作は、認証・RBAC・監査ログ基盤の完成後に別タスクで追加します。
            </StatePanel>
          </>
        )}
      </PageContent>
    </>
  );
}
