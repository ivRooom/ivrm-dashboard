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
} from "../../components/console-ui";
import { MetricLineChart } from "../../components/metric-line-chart";
import {
  HISTORY_RANGE_CONFIG,
  getContainerMetricHistory,
  getHostMetricHistory,
  getObservabilityRetentionState,
  parseHistoryRange,
  type HistoryRange,
} from "../../lib/history";
import { getHistoryStatusOverlays } from "../../lib/history-status-overlays";
import { getMinecraftMetricHistory } from "../../lib/minecraft-history";
import styles from "./history.module.css";

export const dynamic = "force-dynamic";

type HistoryPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const HISTORY_RANGES = Object.keys(HISTORY_RANGE_CONFIG) as HistoryRange[];
const MINECRAFT_CONTAINER_NAMES = new Set(["ivrm-velocity", "mc-main"]);

function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] || null;
  }
  return value || null;
}

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

function formatDateTime(timestamp: string | null): string {
  if (!timestamp) {
    return "未実行";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo",
  }).format(new Date(timestamp));
}

function toKiBPerSecond(value: number | null): number | null {
  return value === null ? null : value / 1_024;
}

export default async function HistoryPage({ searchParams }: HistoryPageProps) {
  const params = await searchParams;
  const range = parseHistoryRange(firstValue(params.range));
  const rangeConfig = HISTORY_RANGE_CONFIG[range];
  const requestedAt = new Date().toISOString();

  const [
    hostResult,
    containerResult,
    minecraftResult,
    retentionResult,
    overlayResult,
  ] = await Promise.allSettled([
    getHostMetricHistory(range),
    getContainerMetricHistory(range),
    getMinecraftMetricHistory(range),
    getObservabilityRetentionState(),
    getHistoryStatusOverlays(range),
  ]);

  const hostHistory = hostResult.status === "fulfilled" ? hostResult.value : [];
  const containerHistory =
    containerResult.status === "fulfilled" ? containerResult.value : [];
  const minecraftHistory =
    minecraftResult.status === "fulfilled" ? minecraftResult.value : [];
  const retentionState =
    retentionResult.status === "fulfilled" ? retentionResult.value : null;
  const overlayState =
    overlayResult.status === "fulfilled" ? overlayResult.value : null;
  const hostDataError = hostResult.status === "rejected";
  const containerDataError = containerResult.status === "rejected";
  const minecraftDataError = minecraftResult.status === "rejected";
  const retentionDataError = retentionResult.status === "rejected";
  const overlayDataError = overlayResult.status === "rejected";

  if (hostResult.status === "rejected") {
    console.error("ホスト監視履歴の取得に失敗しました", hostResult.reason);
  }
  if (containerResult.status === "rejected") {
    console.error("Docker監視履歴の取得に失敗しました", containerResult.reason);
  }
  if (minecraftResult.status === "rejected") {
    console.error("Minecraft監視履歴の取得に失敗しました", minecraftResult.reason);
  }
  if (retentionResult.status === "rejected") {
    console.error("監視Retention状態の取得に失敗しました", retentionResult.reason);
  }
  if (overlayResult.status === "rejected") {
    console.error("監視状態Overlayの取得に失敗しました", overlayResult.reason);
  }

  const chartEndAt = overlayState?.generatedAt ?? requestedAt;
  const chartStartAt = new Date(
    Date.parse(chartEndAt) - rangeConfig.hours * 60 * 60 * 1_000,
  ).toISOString();
  const hostRegions = overlayState?.hostRegions ?? [];
  const containerRegions = overlayState
    ? [...overlayState.hostRegions, ...overlayState.containerRegions]
    : [];
  const minecraftHostIds = new Set(minecraftHistory.map((item) => item.hostId));
  const minecraftRegions = overlayState
    ? [
        ...overlayState.hostRegions.filter((region) =>
          minecraftHostIds.has(region.hostId),
        ),
        ...overlayState.containerRegions.filter(
          (region) =>
            minecraftHostIds.has(region.hostId) &&
            region.containerName !== null &&
            MINECRAFT_CONTAINER_NAMES.has(region.containerName),
        ),
      ]
    : [];

  const hostLoadSeries = hostHistory.flatMap((item) => [
    {
      id: `${item.hostId}:load1`,
      label: `${item.hostDisplayName} / Load 1m`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: point.loadAverage1,
      })),
    },
    {
      id: `${item.hostId}:load5`,
      label: `${item.hostDisplayName} / Load 5m`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: point.loadAverage5,
      })),
    },
    {
      id: `${item.hostId}:load15`,
      label: `${item.hostDisplayName} / Load 15m`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: point.loadAverage15,
      })),
    },
  ]);

  const hostMemorySeries = hostHistory.map((item) => ({
    id: `${item.hostId}:memory`,
    label: item.hostDisplayName,
    points: item.points.map((point) => ({
      timestamp: point.timestamp,
      value: point.memoryPercent,
    })),
  }));

  const hostDiskSeries = hostHistory.map((item) => ({
    id: `${item.hostId}:disk`,
    label: item.hostDisplayName,
    points: item.points.map((point) => ({
      timestamp: point.timestamp,
      value: point.diskPercent,
    })),
  }));

  const minecraftPlayerSeries = minecraftHistory.flatMap((item) => [
    {
      id: `${item.hostId}:minecraft-public-online`,
      label: `${item.hostDisplayName} / Public`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: point.publicOnline,
      })),
    },
    {
      id: `${item.hostId}:minecraft-backend-online`,
      label: `${item.hostDisplayName} / Backend`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: point.backendOnline,
      })),
    },
  ]);

  const minecraftLatencySeries = minecraftHistory.flatMap((item) => [
    {
      id: `${item.hostId}:minecraft-public-latency`,
      label: `${item.hostDisplayName} / Public`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: point.publicLatencyMs,
      })),
    },
    {
      id: `${item.hostId}:minecraft-backend-latency`,
      label: `${item.hostDisplayName} / Backend`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: point.backendLatencyMs,
      })),
    },
  ]);

  const minecraftTpsSeries = minecraftHistory.flatMap((item) => [
    {
      id: `${item.hostId}:minecraft-tps-1m`,
      label: `${item.hostDisplayName} / TPS 1m`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: point.tps1m,
      })),
    },
    {
      id: `${item.hostId}:minecraft-tps-5m`,
      label: `${item.hostDisplayName} / TPS 5m`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: point.tps5m,
      })),
    },
    {
      id: `${item.hostId}:minecraft-tps-15m`,
      label: `${item.hostDisplayName} / TPS 15m`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: point.tps15m,
      })),
    },
  ]);

  const minecraftMsptSeries = minecraftHistory.flatMap((item) => [
    {
      id: `${item.hostId}:minecraft-mspt-median`,
      label: `${item.hostDisplayName} / Median`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: point.msptMedian1m,
      })),
    },
    {
      id: `${item.hostId}:minecraft-mspt-p95`,
      label: `${item.hostDisplayName} / P95`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: point.msptP95_1m,
      })),
    },
    {
      id: `${item.hostId}:minecraft-mspt-max`,
      label: `${item.hostDisplayName} / Max`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: point.msptMax1m,
      })),
    },
  ]);

  const containerLabel = (host: string, container: string) =>
    `${container} / ${host}`;

  const cpuSeries = containerHistory.map((item) => ({
    id: `${item.hostId}:${item.containerName}:cpu`,
    label: containerLabel(item.hostDisplayName, item.containerName),
    points: item.points.map((point) => ({
      timestamp: point.timestamp,
      value: point.cpuPercent,
    })),
  }));

  const memorySeries = containerHistory.map((item) => ({
    id: `${item.hostId}:${item.containerName}:memory`,
    label: containerLabel(item.hostDisplayName, item.containerName),
    points: item.points.map((point) => ({
      timestamp: point.timestamp,
      value: point.memoryPercent,
    })),
  }));

  const pidsSeries = containerHistory.map((item) => ({
    id: `${item.hostId}:${item.containerName}:pids`,
    label: containerLabel(item.hostDisplayName, item.containerName),
    points: item.points.map((point) => ({
      timestamp: point.timestamp,
      value: point.pids,
    })),
  }));

  const restartSeries = containerHistory.map((item) => ({
    id: `${item.hostId}:${item.containerName}:restart`,
    label: containerLabel(item.hostDisplayName, item.containerName),
    points: item.points.map((point) => ({
      timestamp: point.timestamp,
      value: point.restartCount,
    })),
  }));

  const networkSeries = containerHistory.flatMap((item) => [
    {
      id: `${item.hostId}:${item.containerName}:network-rx`,
      label: `${containerLabel(item.hostDisplayName, item.containerName)} / RX`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: toKiBPerSecond(point.networkRxRateBps),
      })),
    },
    {
      id: `${item.hostId}:${item.containerName}:network-tx`,
      label: `${containerLabel(item.hostDisplayName, item.containerName)} / TX`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: toKiBPerSecond(point.networkTxRateBps),
      })),
    },
  ]);

  const blockSeries = containerHistory.flatMap((item) => [
    {
      id: `${item.hostId}:${item.containerName}:block-read`,
      label: `${containerLabel(item.hostDisplayName, item.containerName)} / Read`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: toKiBPerSecond(point.blockReadRateBps),
      })),
    },
    {
      id: `${item.hostId}:${item.containerName}:block-write`,
      label: `${containerLabel(item.hostDisplayName, item.containerName)} / Write`,
      points: item.points.map((point) => ({
        timestamp: point.timestamp,
        value: toKiBPerSecond(point.blockWriteRateBps),
      })),
    },
  ]);

  const hostSampleCount = hostHistory.reduce(
    (total, item) =>
      total + item.points.reduce((sum, point) => sum + point.sampleCount, 0),
    0,
  );
  const containerSampleCount = containerHistory.reduce(
    (total, item) =>
      total + item.points.reduce((sum, point) => sum + point.sampleCount, 0),
    0,
  );
  const minecraftSampleCount = minecraftHistory.reduce(
    (total, item) =>
      total + item.points.reduce((sum, point) => sum + point.sampleCount, 0),
    0,
  );
  const minecraftPerformanceSampleCount = minecraftHistory.reduce(
    (total, item) =>
      total +
      item.points.reduce(
        (sum, point) => sum + point.performanceSampleCount,
        0,
      ),
    0,
  );
  const sourceLabel =
    range === "7d" || range === "30d"
      ? "5分ロールアップ"
      : "生データ";
  const retentionStatusLabel = retentionDataError
    ? "取得エラー"
    : retentionState?.enabled
      ? "稼働中"
      : "停止中";

  const sharedChartProps = {
    startAt: chartStartAt,
    endAt: chartEndAt,
    expectedIntervalSeconds: rangeConfig.bucketSeconds,
    aggregationLabel: rangeConfig.aggregationLabel,
    periodLabel: rangeConfig.label,
  } as const;

  return (
    <>
      <AutoRefresh intervalMs={rangeConfig.refreshMs} />
      <PageContent className={styles.historyContent}>
        <PageHeader
          actions={<ActionLink href="/">現在値へ戻る</ActionLink>}
          description="Minecraft、ホスト、Dockerコンテナの負荷・利用状況・I/O推移を時系列で確認できます。"
          eyebrow="OBSERVABILITY / HISTORY"
          title="監視履歴"
        />

        <MetricGrid label="履歴表示条件">
          <MetricCard label="表示期間" value={`直近${rangeConfig.label}`} />
          <MetricCard label="集約粒度" value={rangeConfig.aggregationLabel} />
          <MetricCard label="データソース" value={sourceLabel} />
          <MetricCard
            label="ホスト"
            tone={hostDataError ? "danger" : "neutral"}
            value={hostDataError ? "—" : hostHistory.length}
          />
          <MetricCard
            label="コンテナ"
            tone={containerDataError ? "danger" : "neutral"}
            value={containerDataError ? "—" : containerHistory.length}
          />
          <MetricCard
            detail="Host / Container / Minecraft"
            label="集約元サンプル"
            tone={hostDataError || containerDataError || minecraftDataError ? "warning" : "neutral"}
            value={`H ${hostDataError ? "—" : hostSampleCount.toLocaleString("ja-JP")} / C ${containerDataError ? "—" : containerSampleCount.toLocaleString("ja-JP")} / MC ${minecraftDataError ? "—" : minecraftSampleCount.toLocaleString("ja-JP")}`}
          />
        </MetricGrid>

        <div className={styles.toolbar}>
          <nav className={styles.periodSelector} aria-label="表示期間">
            {HISTORY_RANGES.map((candidate) => (
              <a
                aria-current={candidate === range ? "page" : undefined}
                className={candidate === range ? styles.active : undefined}
                href={`/history?range=${candidate}`}
                key={candidate}
              >
                {HISTORY_RANGE_CONFIG[candidate].label}
              </a>
            ))}
          </nav>
          <small>
            {formatPeriod(chartStartAt)}〜{formatPeriod(chartEndAt)}
          </small>
        </div>

        <section className={styles.retentionPanel} aria-label="データ保持 Health">
          <SectionHeader
            aside={
              <span role="status">
                <StatusBadge
                  tone={
                    retentionDataError
                      ? "danger"
                      : retentionState?.enabled
                        ? "success"
                        : "warning"
                  }
                >
                  {retentionStatusLabel}
                </StatusBadge>
              </span>
            }
            eyebrow="RETENTION"
            title="データ保持 Health"
          />

          {retentionDataError || !retentionState ? (
            <StatePanel title="Retention状態を取得できませんでした" variant="error">
              履歴グラフ自体は継続して利用できます。
            </StatePanel>
          ) : (
            <>
              <div className={styles.retentionGrid}>
                <div>
                  <span>Raw保持</span>
                  <strong>{retentionState.rawRetentionDays}日</strong>
                </div>
                <div>
                  <span>5分Rollup保持</span>
                  <strong>{retentionState.rollupRetentionDays}日</strong>
                </div>
                <div>
                  <span>1回の削除上限</span>
                  <strong>
                    {retentionState.batchSize.toLocaleString("ja-JP")}件
                  </strong>
                </div>
                <div>
                  <span>前回実行</span>
                  <strong className={styles.retentionTime}>
                    {formatDateTime(retentionState.lastRunAt)}
                  </strong>
                </div>
                <div>
                  <span>前回Raw削除</span>
                  <strong className={styles.retentionCounts}>
                    H {retentionState.lastDeletedHeartbeats.toLocaleString("ja-JP")} / C{" "}
                    {retentionState.lastDeletedContainerSamples.toLocaleString("ja-JP")} / MC{" "}
                    {retentionState.lastDeletedMinecraftSamples.toLocaleString("ja-JP")}
                  </strong>
                </div>
                <div>
                  <span>前回Rollup削除</span>
                  <strong className={styles.retentionCounts}>
                    H {retentionState.lastDeletedHostRollups.toLocaleString("ja-JP")} / C{" "}
                    {retentionState.lastDeletedContainerRollups.toLocaleString("ja-JP")} / MC{" "}
                    {retentionState.lastDeletedMinecraftRollups.toLocaleString("ja-JP")}
                  </strong>
                </div>
              </div>
              <p className={styles.retentionMeta}>
                Retentionの設定変更・削除実行はDB管理者に限定されています。Consoleは状態確認のみ行います。
              </p>
            </>
          )}
        </section>

        {overlayDataError ? (
          <StatePanel title="状態期間Overlayを取得できませんでした" variant="error">
            メトリクス履歴自体は継続して利用できます。
          </StatePanel>
        ) : null}

        <section
          className={styles.metricSection}
          id="minecraft-history"
          aria-label="Minecraft履歴"
        >
          <SectionHeader
            description={
              <>
                Public / BackendのOnline人数・Status Probe Latencyと、Sparkからサーバー内部で実測したTPS / MSPTを同じ時間軸で確認します。Performance未収集区間は0補完せず欠損表示します。Spark Performance集約元: {minecraftPerformanceSampleCount.toLocaleString("ja-JP")}件。
              </>
            }
            eyebrow="MINECRAFT"
            title="Minecraft履歴"
          />

          {minecraftDataError ? (
            <StatePanel title="Minecraft履歴を取得できませんでした" variant="error">
              SupabaseのMinecraft履歴RPCを確認してください。
            </StatePanel>
          ) : (
            <div className={styles.chartGrid}>
              <MetricLineChart
                {...sharedChartProps}
                title="Online Players"
                description="Public EndpointとBackendが返したOnline人数のバケット平均です。"
                regions={minecraftRegions}
                series={minecraftPlayerSeries}
                unit="人"
                valueDigits={1}
              />
              <MetricLineChart
                {...sharedChartProps}
                title="Status Probe Latency"
                description="Public EndpointとBackendへのMinecraft Status応答時間のバケット平均です。"
                regions={minecraftRegions}
                series={minecraftLatencySeries}
                unit=" ms"
                valueDigits={0}
              />
              <MetricLineChart
                {...sharedChartProps}
                title="TPS"
                description="Sparkがサーバー内部で実測した1分・5分・15分rolling TPSです。Performance未収集区間は欠損として表示します。"
                regions={minecraftRegions}
                series={minecraftTpsSeries}
                unit=""
                valueDigits={2}
              />
              <MetricLineChart
                {...sharedChartProps}
                title="MSPT"
                description="Sparkの直近1分Tick durationです。Median / P95はバケット平均、Maxは期間内の最大値を保持します。"
                regions={minecraftRegions}
                series={minecraftMsptSeries}
                unit=" ms"
                valueDigits={1}
              />
            </div>
          )}
        </section>

        <section className={styles.metricSection} aria-label="ホスト履歴">
          <SectionHeader
            description="OSレベルのLoad Average・メモリ・ディスク使用率です。"
            eyebrow="HOST"
            title="ホスト履歴"
          />

          {hostDataError ? (
            <StatePanel title="ホスト履歴を取得できませんでした" variant="error">
              Supabaseのホスト履歴RPCを確認してください。
            </StatePanel>
          ) : (
            <div className={styles.chartGrid}>
              <MetricLineChart
                {...sharedChartProps}
                title="Load Average"
                description="1分・5分・15分の平均実行待ち負荷を比較します。"
                regions={hostRegions}
                series={hostLoadSeries}
                unit=""
              />
              <MetricLineChart
                {...sharedChartProps}
                title="ホストメモリ使用率"
                description="総メモリとAvailableから算出した使用率です。"
                regions={hostRegions}
                series={hostMemorySeries}
                unit="%"
                maximum={100}
              />
              <MetricLineChart
                {...sharedChartProps}
                title="ディスク使用率"
                description="監視対象ファイルシステムの総容量とAvailableから算出します。"
                regions={hostRegions}
                series={hostDiskSeries}
                unit="%"
                maximum={100}
              />
            </div>
          )}
        </section>

        <section className={styles.metricSection} aria-label="コンテナ履歴">
          <SectionHeader
            description="CPU・メモリに加えて、Process数・再起動回数・Network / Block I/Oを確認します。"
            eyebrow="DOCKER"
            title="コンテナ履歴"
          />

          {containerDataError ? (
            <StatePanel title="Docker監視履歴を取得できませんでした" variant="error">
              SupabaseのDocker履歴RPCを確認してください。
            </StatePanel>
          ) : (
            <div className={styles.chartGrid}>
              <MetricLineChart
                {...sharedChartProps}
                title="CPU使用率"
                description="各コンテナのCPU使用率です。欠損区間は線を接続しません。"
                regions={containerRegions}
                series={cpuSeries}
                unit="%"
              />
              <MetricLineChart
                {...sharedChartProps}
                title="メモリ使用率"
                description="使用量をコンテナのメモリ上限で割った使用率です。"
                regions={containerRegions}
                series={memorySeries}
                unit="%"
                maximum={100}
              />
              <MetricLineChart
                {...sharedChartProps}
                title="PIDs"
                description="コンテナ内で観測したProcess数の推移です。"
                regions={containerRegions}
                series={pidsSeries}
                unit=""
                valueDigits={0}
              />
              <MetricLineChart
                {...sharedChartProps}
                title="再起動回数"
                description="Docker RestartCountの最新値を各時間バケットへ保持します。"
                regions={containerRegions}
                series={restartSeries}
                unit=""
                valueDigits={0}
              />
              <MetricLineChart
                {...sharedChartProps}
                title="Network I/O"
                description="Dockerの累積RX/TX Counterを区間差分からKiB/sへ変換します。Counter resetは欠損扱いです。"
                regions={containerRegions}
                series={networkSeries}
                unit=" KiB/s"
              />
              <MetricLineChart
                {...sharedChartProps}
                title="Block I/O"
                description="Dockerの累積Read/Write Counterを区間差分からKiB/sへ変換します。Counter resetは欠損扱いです。"
                regions={containerRegions}
                series={blockSeries}
                unit=" KiB/s"
              />
            </div>
          )}
        </section>

        <StatePanel title="データ保持・状態Overlayについて" variant="info">
          1時間・6時間・24時間は生データから期間に応じて集約し、7日・30日は5分ロールアップを再集約します。Rawは既定7日、5分Rollupは既定90日保持します。Minecraft Rawも対応する5分Rollupを確認してから削除します。Spark TPS/MSPTはPerformance取得成功Sampleだけを集約し、MSPT Maxは期間内最大値を維持します。グラフ背景帯はHeartbeat gap、構造化Container Transition、Maintenanceイベントと最新SnapshotからStale・Offline・Error・Maintenanceの継続期間を復元します。
        </StatePanel>
      </PageContent>
    </>
  );
}
