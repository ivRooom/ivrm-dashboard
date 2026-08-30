import { AutoRefresh } from "../../components/auto-refresh";
import {
  ActionLink,
  MetricCard,
  MetricGrid,
  PageContent,
  PageHeader,
  StatePanel,
  StatusBadge,
  type ConsoleTone,
} from "../../components/console-ui";
import {
  getMonitoringSnapshot,
  type ContainerExpectedState,
  type ContainerOverview,
  type ContainerStatus,
  type HostOverview,
} from "../../lib/monitoring";
import styles from "./containers.module.css";

export const dynamic = "force-dynamic";

const statusLabels: Record<ContainerStatus, string> = {
  online: "稼働中",
  offline: "受信停止",
  stale: "更新遅延",
  error: "異常",
  standby: "待機中",
  maintenance: "メンテナンス",
};

const expectedStateLabels: Record<ContainerExpectedState, string> = {
  running: "稼働",
  stopped: "停止",
  absent: "未作成",
};

function statusTone(status: ContainerStatus): ConsoleTone {
  if (status === "online") return "success";
  if (status === "standby") return "info";
  if (status === "maintenance") return "maintenance";
  if (status === "stale") return "warning";
  return "danger";
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "未取得";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatMemory(container: ContainerOverview): string {
  if (
    container.memoryUsageBytes === null ||
    container.memoryLimitBytes === null ||
    container.memoryLimitBytes <= 0
  ) {
    return "未取得";
  }
  const percent = (container.memoryUsageBytes / container.memoryLimitBytes) * 100;
  return `${formatBytes(container.memoryUsageBytes)} / ${percent.toFixed(1)}%`;
}

function formatRelativeTime(timestamp: string, reference: string): string {
  const target = Date.parse(timestamp);
  const now = Date.parse(reference);
  if (!Number.isFinite(target) || !Number.isFinite(now)) return "時刻不明";
  const ageSeconds = Math.max(0, Math.floor((now - target) / 1_000));
  if (ageSeconds < 60) return `${ageSeconds}秒前`;
  if (ageSeconds < 3_600) return `${Math.floor(ageSeconds / 60)}分前`;
  if (ageSeconds < 86_400) return `${Math.floor(ageSeconds / 3_600)}時間前`;
  return `${Math.floor(ageSeconds / 86_400)}日前`;
}

function expectationLabel(container: ContainerOverview): string {
  return container.expectedState
    ? expectedStateLabels[container.expectedState]
    : "未設定";
}

function hostById(hosts: HostOverview[]): Map<string, HostOverview> {
  return new Map(hosts.map((host) => [host.id, host]));
}

export default async function ContainersPage() {
  let hosts: HostOverview[] = [];
  let containers: ContainerOverview[] = [];
  let generatedAt = new Date().toISOString();
  let hasDataError = false;

  try {
    const snapshot = await getMonitoringSnapshot();
    hosts = snapshot.hosts;
    containers = snapshot.containers;
    generatedAt = snapshot.generatedAt;
  } catch (error) {
    hasDataError = true;
    console.error("コンテナ一覧の取得に失敗しました", error);
  }

  const hostsById = hostById(hosts);
  const healthyCount = containers.filter((container) =>
    ["online", "standby", "maintenance"].includes(container.status),
  ).length;
  const issueCount = containers.filter((container) =>
    ["offline", "stale", "error"].includes(container.status),
  ).length;
  const maintenanceCount = containers.filter(
    (container) => container.maintenanceActive,
  ).length;

  return (
    <>
      <AutoRefresh intervalMs={15_000} />
      <PageContent className={styles.containerContent}>
        <PageHeader
          eyebrow="CONTAINER INVENTORY"
          title="Dockerコンテナ"
          description="監視対象を選択して、現在値と個別の時系列履歴へ掘り下げます。"
          actions={
            <>
              <ActionLink href="/">システム概要</ActionLink>
              <ActionLink href="/history">全体履歴</ActionLink>
            </>
          }
        />

        <MetricGrid label="コンテナ監視サマリー">
          <MetricCard
            label="MONITORED"
            value={hasDataError ? "—" : containers.length}
            detail={`${hosts.length}ホストから受信`}
          />
          <MetricCard
            label="HEALTHY / STANDBY"
            value={hasDataError ? "—" : healthyCount}
            detail="稼働・待機・メンテナンス"
            tone={hasDataError ? "neutral" : "success"}
          />
          <MetricCard
            label="NEEDS ATTENTION"
            value={hasDataError ? "—" : issueCount}
            detail="受信停止・遅延・異常"
            tone={!hasDataError && issueCount > 0 ? "danger" : "neutral"}
          />
          <MetricCard
            label="MAINTENANCE"
            value={hasDataError ? "—" : maintenanceCount}
            detail="現在有効な計画作業"
            tone="neutral"
          />
        </MetricGrid>

        {hasDataError ? (
          <StatePanel title="コンテナ一覧を取得できませんでした" variant="error">
            監視データの取得経路を確認してください。
          </StatePanel>
        ) : containers.length === 0 ? (
          <StatePanel title="監視対象のコンテナがありません">
            AgentからDocker Snapshotを受信するとここへ表示されます。
          </StatePanel>
        ) : (
          <section className={styles.containerGrid} aria-label="コンテナ一覧">
            {containers.map((container) => {
              const host = hostsById.get(container.hostId);
              const detailHref = host
                ? `/containers/${encodeURIComponent(host.serverId)}/${encodeURIComponent(container.name)}`
                : null;

              return (
                <article
                  className={styles.containerCard}
                  key={`${container.hostId}:${container.name}`}
                >
                  <div className={styles.cardTop}>
                    <div className={styles.identity}>
                      <p>{container.hostDisplayName}</p>
                      <h2>
                        {detailHref ? (
                          <a className={styles.detailLink} href={detailHref}>
                            {container.name}
                          </a>
                        ) : (
                          container.name
                        )}
                      </h2>
                    </div>
                    <StatusBadge tone={statusTone(container.status)}>
                      {statusLabels[container.status]}
                    </StatusBadge>
                  </div>

                  <div className={styles.metaGrid}>
                    <div>
                      <span>STATE / HEALTH</span>
                      <strong>
                        {container.state} / {container.health}
                      </strong>
                      <small>Restart {container.restartCount}</small>
                    </div>
                    <div>
                      <span>CPU / PIDS</span>
                      <strong>
                        {container.cpuPercent === null
                          ? "未取得"
                          : `${container.cpuPercent.toFixed(2)}% / ${container.pids ?? "—"}`}
                      </strong>
                    </div>
                    <div>
                      <span>MEMORY</span>
                      <strong>{formatMemory(container)}</strong>
                    </div>
                    <div>
                      <span>EXPECTED</span>
                      <strong>{expectationLabel(container)}</strong>
                    </div>
                    <div>
                      <span>NETWORK RX / TX</span>
                      <strong>
                        {formatBytes(container.networkRxBytes)} / {formatBytes(container.networkTxBytes)}
                      </strong>
                    </div>
                    <div>
                      <span>LAST SAMPLE</span>
                      <strong>{formatRelativeTime(container.receivedAt, generatedAt)}</strong>
                    </div>
                  </div>

                  {detailHref ? (
                    <ActionLink href={detailHref}>現在値と履歴を開く →</ActionLink>
                  ) : null}
                </article>
              );
            })}
          </section>
        )}
      </PageContent>
    </>
  );
}
