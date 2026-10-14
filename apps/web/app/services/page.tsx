import { AutoRefresh } from "../../components/auto-refresh";
import { ActionLink, PageHeader, StatePanel, StatusBadge } from "../../components/console-ui";
import { BRAND_SERVICES, combineServiceHealth, type ServiceHealth } from "../../lib/service-catalog";
import { getMonitoringSnapshot } from "../../lib/monitoring";
import { getCloudTargets } from "../../lib/cloud-monitor";
import { cloudHealth } from "../../lib/cloud-monitor-core";
import { getMinecraftOverview } from "../../lib/minecraft";
import { getRuntimeInventory } from "../../lib/runtime-inventory";
import styles from "./services.module.css";

export const dynamic = "force-dynamic";
const labels = { operational: "正常", attention: "要確認", unknown: "監視未完了" } as const;
const tone = (health: ServiceHealth) => health === "operational" ? "success" : health === "attention" ? "danger" : "neutral";

export default async function ServicesPage() {
  const monitoringPromise = getMonitoringSnapshot();
  const [monitoringResult, cloudResult, minecraftResult, runtimeResult] = await Promise.allSettled([monitoringPromise, getCloudTargets(), getMinecraftOverview(monitoringPromise), getRuntimeInventory()]);
  const monitoring = monitoringResult.status === "fulfilled" ? monitoringResult.value : null;
  const clouds = cloudResult.status === "fulfilled" ? cloudResult.value : null;
  const now = Date.now();
  return <section className="content">
    <AutoRefresh intervalMs={30_000} />
    <PageHeader title="サービス監視" eyebrow="IVRM.JP / SERVICES" description="サービスごとに公開監視・ホスト・コンテナ・共通依存を確認します。構成の登録だけでは正常と判定しません。" actions={<ActionLink href="/operations">運用操作</ActionLink>} />
    {(!monitoring || !clouds || runtimeResult.status === "rejected") && <StatePanel title="一部の監視データを取得できません" variant="error">取得できない情報は未確認として表示しています。</StatePanel>}
    <div className={styles.grid}>{BRAND_SERVICES.map(service => {
      const host = monitoring?.hosts.find(row => row.serverId === service.serverId);
      const runtime = runtimeResult.status === "fulfilled" ? runtimeResult.value.find(row => row.serverId === service.serverId) : undefined;
      const runtimeFresh = runtime && Date.parse(runtime.observedAt) <= now+30000 && now-Date.parse(runtime.observedAt)<=900000 && Date.parse(runtime.receivedAt)<=now+30000 && now-Date.parse(runtime.receivedAt)<=900000;
      const expected = [...service.containers, ...service.dependencies];
      const containers = expected.map(name => ({ name, dependency: service.dependencies.includes(name), sample: monitoring?.containers.find(row => row.hostId === host?.id && row.name === name), runtimeSample: runtime?.containers.find(row => row.name === name) }));
      const checks = [...service.cloudTargets, ...(service.publicTarget ? [service.publicTarget] : [])].map(id => {
        const target = clouds?.find(row => row.id === id);
        const status = target?.enabled ? cloudHealth(target.status, target.received_at, target.stale_after_seconds, now) : "unknown";
        const health: ServiceHealth = status === "operational" ? "operational" : status === "unknown" ? "unknown" : "attention";
        return { id, label: target?.display_name ?? id, health };
      });
      const states: ServiceHealth[] = checks.map(row => row.health);
      if (service.serverId && !runtimeFresh) states.push(!host ? "unknown" : host.status === "online" ? "operational" : "attention");
      states.push(...containers.map(({ sample, runtimeSample }): ServiceHealth => sample ? sample.status === "online" ? "operational" : "attention" : !runtimeSample || runtimeSample.collection === "unavailable" ? "unknown" : !runtimeFresh || runtimeSample.state !== "running" || runtimeSample.health === "unhealthy" || runtimeSample.health === "starting" || runtimeSample.oomKilled ? "attention" : "operational"));
      const minecraftHealth: ServiceHealth = minecraftResult.status !== "fulfilled" || minecraftResult.value.status === "unknown" ? "unknown" : minecraftResult.value.status === "operational" ? "operational" : "attention";
      if (service.id === "minecraft") states.push(minecraftHealth);
      const health = combineServiceHealth(states);
      return <article className={styles.card} key={service.id}>
        <div className={styles.header}><div><h2>{service.domain}</h2><span className={styles.muted}>{service.label} · {service.provider}</span></div><StatusBadge tone={tone(health)}>{labels[health]}</StatusBadge></div>
        <p className={styles.muted}>ホスト: {service.serverId ?? "マネージドホスティング"}{service.serverId && !host && !runtime ? "（Agent未登録・未受信）" : ""}</p>
        {runtime && <p className={styles.muted}>Docker最終観測: {new Date(runtime.observedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}{!runtimeFresh ? "（収集停止）" : ""}</p>}
        <ul className={styles.list} aria-label={`${service.domain}のコンテナ`}>{containers.map(({ name, dependency, sample, runtimeSample }) => <li key={name}>
          <div>{sample && host ? <a href={`/containers/${encodeURIComponent(host.serverId)}/${encodeURIComponent(name)}`}>{name}</a> : name}<small className={styles.muted}>{dependency ? " · 共通依存" : ""}</small></div>
          <span className={styles.muted}>{sample ? `${sample.status} · ${sample.state}${sample.cpuPercent !== null ? ` · CPU ${sample.cpuPercent.toFixed(1)}%` : ""}${sample.memoryUsageBytes !== null ? ` · RAM ${Math.round(sample.memoryUsageBytes / 1048576)} MiB` : ""}` : runtimeSample?.collection === "ok" ? `${runtimeFresh ? runtimeSample.state : "収集停止"} · ${runtimeSample.health} · restart ${runtimeSample.restartCount}${runtimeSample.oomKilled ? " · OOM" : ""}` : "未受信"}</span>
          {runtimeSample?.collection === "ok" && <details><summary>配備イメージ</summary><p className={styles.muted}>{runtimeSample.image}</p><p className={styles.muted}>ローカルImage ID: {runtimeSample.imageId}</p></details>}
        </li>)}</ul>
        <ul className={styles.list} aria-label={`${service.domain}のクラウド・公開監視`}>{checks.map(check => <li key={check.id}><span>{check.label}</span><StatusBadge tone={tone(check.health)}>{labels[check.health]}</StatusBadge></li>)}</ul>
        {service.id === "minecraft" && <p>TCP・ゲーム監視 <StatusBadge tone={tone(minecraftHealth)}>{labels[minecraftHealth]}</StatusBadge></p>}
        <div className={styles.actions}>{host && <ActionLink href={`/hosts/${encodeURIComponent(host.serverId)}`}>ホスト詳細</ActionLink>}{service.operationTarget && <><ActionLink href="/operations">Minecraft操作</ActionLink><ActionLink href="/minecraft">TCP・ゲーム監視</ActionLink></>}</div>
        {!service.operationTarget && service.serverId && <p className={styles.muted}>このサービスのコマンド・起動停止は未接続です。</p>}
      </article>;
    })}</div>
  </section>;
}
