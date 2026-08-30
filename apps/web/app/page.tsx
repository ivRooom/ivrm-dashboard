import { AutoRefresh } from "../components/auto-refresh";
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
} from "../components/console-ui";
import type { MinecraftOverallStatus } from "../lib/minecraft";
import type { ContainerStatus, HostOverview } from "../lib/monitoring";
import {
  getOverviewSnapshot,
  type OverviewActivityTone,
} from "../lib/overview";
import type { ReliabilityHealth } from "../lib/reliability-types";
import styles from "./overview.module.css";

export const dynamic = "force-dynamic";

const reliabilityLabels: Record<ReliabilityHealth, string> = {
  operational: "正常",
  degraded: "注意",
  critical: "重大",
  disabled: "停止中",
  unknown: "未確認",
};

const minecraftLabels: Record<MinecraftOverallStatus, string> = {
  operational: "正常稼働",
  degraded: "一部低下",
  partial_outage: "部分障害",
  major_outage: "重大障害",
  maintenance: "メンテナンス",
  unknown: "未確認",
};

const containerLabels: Record<ContainerStatus, string> = {
  online: "稼働中",
  offline: "受信停止",
  stale: "更新遅延",
  error: "異常",
  standby: "待機中",
  maintenance: "メンテナンス",
};

function reliabilityTone(health: ReliabilityHealth): ConsoleTone {
  if (health === "operational") return "success";
  if (health === "degraded") return "warning";
  if (health === "critical") return "danger";
  return "neutral";
}

function minecraftTone(status: MinecraftOverallStatus): ConsoleTone {
  if (status === "operational") return "success";
  if (status === "degraded") return "warning";
  if (status === "partial_outage" || status === "major_outage") return "danger";
  if (status === "maintenance") return "maintenance";
  return "neutral";
}

function activityLabel(tone: OverviewActivityTone): string {
  if (tone === "danger") return "重大";
  if (tone === "warning") return "注意";
  if (tone === "success") return "復旧";
  if (tone === "info") return "通知";
  return "更新";
}

function formatRelativeTime(timestamp: string | null, reference: string): string {
  if (!timestamp) return "未受信";
  const target = Date.parse(timestamp);
  const now = Date.parse(reference);
  if (!Number.isFinite(target) || !Number.isFinite(now)) return "時刻不明";
  const seconds = Math.max(0, Math.floor((now - target) / 1_000));
  if (seconds < 60) return `${seconds}秒前`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}時間前`;
  return `${Math.floor(seconds / 86_400)}日前`;
}

function formatLatency(value: number | null | undefined): string {
  return value === null || value === undefined ? "未取得" : `${value} ms`;
}

function formatTps(values: Array<number | null>): string {
  return values.every((value) => value !== null)
    ? values.map((value) => (value as number).toFixed(2)).join(" / ")
    : "未取得";
}

function formatMspt(median: number | null, p95: number | null): string {
  return median === null || p95 === null
    ? "未取得"
    : `${median.toFixed(2)} / ${p95.toFixed(2)} ms`;
}

function usagePercent(total: number | null, available: number | null): number | null {
  if (total === null || available === null || total <= 0) return null;
  return Math.min(100, Math.max(0, ((total - available) / total) * 100));
}

function maxHostUsage(
  hosts: HostOverview[],
  kind: "memory" | "disk",
): number | null {
  const values = hosts
    .map((host) =>
      kind === "memory"
        ? usagePercent(host.memoryTotalBytes, host.memoryAvailableBytes)
        : usagePercent(host.diskTotalBytes, host.diskAvailableBytes),
    )
    .filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

function maxLoad(hosts: HostOverview[]): number | null {
  const values = hosts
    .map((host) => host.loadAverage1)
    .filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

function formatPercent(value: number | null): string {
  return value === null ? "未取得" : `${value.toFixed(1)}%`;
}

function attentionTone(
  value: number | null,
  severity: "warning" | "danger",
): "neutral" | "warning" | "danger" {
  if (value === null || value === 0) return "neutral";
  return severity;
}

export default async function HomePage() {
  const data = await getOverviewSnapshot();
  const hosts = data.monitoring?.hosts ?? [];
  const containers = data.monitoring?.containers ?? [];
  const onlineHosts = hosts.filter((host) => host.status === "online").length;
  const stableContainers = containers.filter((container) =>
    ["online", "standby", "maintenance"].includes(container.status),
  ).length;
  const maxMemory = maxHostUsage(hosts, "memory");
  const maxDisk = maxHostUsage(hosts, "disk");
  const hostLoad = maxLoad(hosts);
  const unavailableSources = Object.entries(data.sources)
    .filter(([, available]) => !available)
    .map(([source]) => source);
  const minecraft = data.minecraft;

  return (
    <>
      <AutoRefresh intervalMs={30_000} />
      <PageContent className={styles.content}>
        <PageHeader
          className={styles.pageHeader}
          eyebrow="OPERATIONS OVERVIEW"
          title="IVRM Console Overview"
          description="正常か、今すぐ対応が必要か、Minecraftが遊べる状態かを最初に判断するための運用Overviewです。"
          actions={
            <>
              <ActionLink href="/incidents" variant="primary">
                Incident Center
              </ActionLink>
              <ActionLink href="/reliability">Reliability</ActionLink>
            </>
          }
        />

        {unavailableSources.length > 0 ? (
          <StatePanel title="一部データソースを取得できませんでした" variant="warning">
            {`${unavailableSources.join(" / ")} は未取得です。取得できた領域は継続表示しています。`}
          </StatePanel>
        ) : null}

        <section className={styles.section} aria-label="現在のサービス状態">
          <SectionHeader
            eyebrow="SYSTEM STATUS"
            title="現在のサービス状態"
            description="主要5領域を同じ基準で確認し、異常時は詳細画面へ直接移動できます。"
          />
          <div className={styles.systemGrid}>
            <a className={styles.statusCard} href="/minecraft">
              <div className={styles.statusTop}>
                <span>Minecraft</span>
                <StatusBadge tone={minecraftTone(data.status.minecraft)}>
                  {minecraftLabels[data.status.minecraft]}
                </StatusBadge>
              </div>
              <div>
                <strong>
                  {minecraft?.players.online ?? "—"} / {minecraft?.players.max ?? "—"} players
                </strong>
                <small>
                  {formatRelativeTime(minecraft?.checkedAt ?? null, data.generatedAt)}にProbe更新
                </small>
              </div>
            </a>

            <a className={styles.statusCard} href="/inventory">
              <div className={styles.statusTop}>
                <span>Infrastructure</span>
                <StatusBadge tone={reliabilityTone(data.status.infrastructure)}>
                  {reliabilityLabels[data.status.infrastructure]}
                </StatusBadge>
              </div>
              <div>
                <strong>{onlineHosts} / {hosts.length} hosts</strong>
                <small>{stableContainers} / {containers.length} containers 正常・待機</small>
              </div>
            </a>

            <a className={styles.statusCard} href="/backups?range=24h">
              <div className={styles.statusTop}>
                <span>Backup</span>
                <StatusBadge tone={reliabilityTone(data.status.backup)}>
                  {reliabilityLabels[data.status.backup]}
                </StatusBadge>
              </div>
              <div>
                <strong>{data.incidents?.summary.backupActiveCount ?? "—"} active</strong>
                <small>24時間Incidentと保護状態から判定</small>
              </div>
            </a>

            <a className={styles.statusCard} href="/notifications">
              <div className={styles.statusTop}>
                <span>Notification</span>
                <StatusBadge tone={reliabilityTone(data.status.notifications)}>
                  {reliabilityLabels[data.status.notifications]}
                </StatusBadge>
              </div>
              <div>
                <strong>{data.notification?.failedCount ?? "—"} failed</strong>
                <small>
                  Retry {data.notification?.retryCount ?? "—"} / Pending {data.notification?.pendingCount ?? "—"}
                </small>
              </div>
            </a>

            <a className={styles.statusCard} href="/reliability">
              <div className={styles.statusTop}>
                <span>Reliability</span>
                <StatusBadge tone={reliabilityTone(data.status.reliability)}>
                  {reliabilityLabels[data.status.reliability]}
                </StatusBadge>
              </div>
              <div>
                <strong>{data.incidents?.summary.activeCount ?? "—"} active incidents</strong>
                <small>Raw Incident + Backup + Notification health</small>
              </div>
            </a>
          </div>
        </section>

        <section className={styles.section} aria-label="要対応">
          <SectionHeader
            eyebrow="NEEDS ATTENTION"
            title="要対応"
            description="0件なら正常です。件数がある項目から詳細画面へ進んでください。"
            aside={<ActionLink href="/incidents">すべてのIncident</ActionLink>}
          />
          <MetricGrid className={styles.attentionGrid} label="要対応サマリー">
            <MetricCard
              label="ACTIVE CRITICAL"
              value={data.attention.activeCritical ?? "—"}
              detail="重大Incident"
              tone={attentionTone(data.attention.activeCritical, "danger")}
            />
            <MetricCard
              label="ACTIVE WARNING"
              value={data.attention.activeWarning ?? "—"}
              detail="注意Incident"
              tone={attentionTone(data.attention.activeWarning, "warning")}
            />
            <MetricCard
              label="FAILED NOTIFICATION"
              value={data.attention.failedNotifications ?? "—"}
              detail="配送失敗"
              tone={attentionTone(data.attention.failedNotifications, "danger")}
            />
            <MetricCard
              label="BACKUP CRITICAL"
              value={data.attention.backupCritical ?? "—"}
              detail="重大Backup Incident"
              tone={attentionTone(data.attention.backupCritical, "danger")}
            />
            <MetricCard
              label="STALE / OFFLINE"
              value={data.attention.staleOrOffline ?? "—"}
              detail="Host + Container"
              tone={attentionTone(data.attention.staleOrOffline, "warning")}
            />
          </MetricGrid>
        </section>

        <section className={styles.section} aria-label="MinecraftとInfrastructureの現在値">
          <SectionHeader
            eyebrow="QUICK STATUS"
            title="Minecraft / Infrastructure"
            description="詳細画面へ移動する前に、ゲーム状態とホスト余力を短時間で確認します。"
          />
          <div className={styles.quickGrid}>
            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <h3>Minecraft</h3>
                  <p>Public Probe、Backend Probe、Spark performance、主要Containerの現在値。</p>
                </div>
                <ActionLink href="/minecraft">Minecraft詳細</ActionLink>
              </div>
              {minecraft ? (
                <div className={styles.factGrid}>
                  <div className={styles.fact}>
                    <span>Players</span>
                    <strong>{minecraft.players.online ?? "—"} / {minecraft.players.max ?? "—"}</strong>
                    <small>Online / Max</small>
                  </div>
                  <div className={styles.fact}>
                    <span>TPS 1 / 5 / 15m</span>
                    <strong>
                      {formatTps([
                        minecraft.performance.tps1m,
                        minecraft.performance.tps5m,
                        minecraft.performance.tps15m,
                      ])}
                    </strong>
                    <small>{minecraft.performance.source ?? "performance source未取得"}</small>
                  </div>
                  <div className={styles.fact}>
                    <span>MSPT Median / P95</span>
                    <strong>
                      {formatMspt(
                        minecraft.performance.msptMedian1m,
                        minecraft.performance.msptP951m,
                      )}
                    </strong>
                    <small>1 minute window</small>
                  </div>
                  <div className={styles.fact}>
                    <span>Public / Backend</span>
                    <strong>
                      {formatLatency(minecraft.publicEndpoint.latencyMs)} / {formatLatency(minecraft.backendProbe.latencyMs)}
                    </strong>
                    <small>接続Latency</small>
                  </div>
                  <div className={styles.fact}>
                    <span>Velocity</span>
                    <strong>
                      {minecraft.velocity ? containerLabels[minecraft.velocity.status] : "未受信"}
                    </strong>
                    <small>{minecraft.velocity?.state ?? "Container未取得"}</small>
                  </div>
                  <div className={styles.fact}>
                    <span>Backend</span>
                    <strong>
                      {minecraft.backend ? containerLabels[minecraft.backend.status] : "未受信"}
                    </strong>
                    <small>{minecraft.backend?.state ?? "Container未取得"}</small>
                  </div>
                </div>
              ) : (
                <StatePanel title="Minecraft情報を取得できませんでした" variant="warning">
                  MonitoringまたはMinecraft Probeの取得状態を確認してください。
                </StatePanel>
              )}
            </article>

            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <h3>Infrastructure</h3>
                  <p>Hostの現在値とContainer状態を集約。CPU使用率は現行Heartbeatにないため推測しません。</p>
                </div>
                <ActionLink href="/hosts">Host詳細</ActionLink>
              </div>
              {data.monitoring ? (
                <div className={styles.factGrid}>
                  <div className={styles.fact}>
                    <span>Host Load 1m</span>
                    <strong>{hostLoad === null ? "未取得" : hostLoad.toFixed(2)}</strong>
                    <small>監視Hostの最大Load Average</small>
                  </div>
                  <div className={styles.fact}>
                    <span>Memory</span>
                    <strong>{formatPercent(maxMemory)}</strong>
                    <small>Host最大使用率</small>
                  </div>
                  <div className={styles.fact}>
                    <span>Disk</span>
                    <strong>{formatPercent(maxDisk)}</strong>
                    <small>Host最大使用率</small>
                  </div>
                  <div className={styles.fact}>
                    <span>Hosts</span>
                    <strong>{onlineHosts} / {hosts.length}</strong>
                    <small>Online / Total</small>
                  </div>
                  <div className={styles.fact}>
                    <span>Containers</span>
                    <strong>{stableContainers} / {containers.length}</strong>
                    <small>正常・待機・Maintenance / Total</small>
                  </div>
                  <div className={styles.fact}>
                    <span>Freshness</span>
                    <strong>{formatRelativeTime(data.monitoring.generatedAt, data.generatedAt)}</strong>
                    <small>Monitoring Snapshot</small>
                  </div>
                </div>
              ) : (
                <StatePanel title="Infrastructure情報を取得できませんでした" variant="warning">
                  Monitoring SnapshotのServer-side接続を確認してください。
                </StatePanel>
              )}
            </article>
          </div>
        </section>

        <section className={styles.section} aria-label="直近の運用変化">
          <SectionHeader
            eyebrow="RECENT ACTIVITY"
            title="直近の運用変化"
            description="生ログではなく、既存の構造化Incident・Recovery・Backup Incident・Notification情報だけを表示します。"
            aside={<span className={styles.sourceNote}>24時間 / 最大6件</span>}
          />
          {data.activities.length > 0 ? (
            <div className={styles.activityList}>
              {data.activities.map((activity) => (
                <a className={styles.activityLink} href={activity.href} key={activity.id}>
                  <StatusBadge tone={activity.tone}>{activityLabel(activity.tone)}</StatusBadge>
                  <div className={styles.activityCopy}>
                    <strong>{activity.title}</strong>
                    <small>{activity.detail}</small>
                  </div>
                  <time className={styles.activityTime} dateTime={activity.occurredAt}>
                    {formatRelativeTime(activity.occurredAt, data.generatedAt)}
                  </time>
                </a>
              ))}
            </div>
          ) : (
            <StatePanel title="直近24時間に表示する運用変化はありません">
              Incident、Recovery、Backup保護イベント、通知配送が発生するとここへ表示されます。
            </StatePanel>
          )}
        </section>
      </PageContent>
    </>
  );
}
