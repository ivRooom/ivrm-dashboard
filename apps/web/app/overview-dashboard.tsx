"use client";

import { useMemo, useState } from "react";
import { AutoRefresh } from "../components/auto-refresh";
import { ActionLink, StatePanel, StatusBadge, type ConsoleTone } from "../components/console-ui";
import type { ContainerOverview, HostOverview } from "../lib/monitoring";
import type { OverviewActivity, OverviewSnapshot } from "../lib/overview";
import styles from "./overview.module.css";

const statusText: Record<string, string> = { online: "ONLINE", offline: "OFFLINE", stale: "STALE", error: "ERROR", standby: "STANDBY", maintenance: "MAINTENANCE" };
const toneFor = (status: string): ConsoleTone => status === "online" ? "success" : status === "offline" || status === "error" ? "danger" : status === "stale" ? "warning" : "neutral";
const percent = (total: number | null, available: number | null) => total && available !== null ? Math.round(((total - available) / total) * 100) : null;
const formatBytes = (value: number | null) => value === null ? "—" : value > 1e9 ? `${(value / 1e9).toFixed(1)} GB` : `${Math.round(value / 1e6)} MB`;
const relative = (date: string | null, now: string) => { if (!date) return "NO SIGNAL"; const seconds = Math.max(0, Math.floor((Date.parse(now) - Date.parse(date)) / 1000)); return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`; };

function Sparkline({ values, tone = "accent" }: { values: number[]; tone?: "accent" | "muted" }) {
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${34 - v * 28}`).join(" ");
  return <svg className={styles.sparkline} viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true"><polyline points={points} className={tone === "accent" ? styles.sparkAccent : styles.sparkMuted} /></svg>;
}

function Metric({ label, value, detail, values, tone = "neutral" }: { label: string; value: string; detail: string; values: number[]; tone?: ConsoleTone }) {
  return <article className={styles.metric} data-tone={tone}><div className={styles.metricTop}><span>{label}</span><span className={styles.metricDot} /></div><strong>{value}</strong><div className={styles.metricBottom}><small>{detail}</small><Sparkline values={values} /></div></article>;
}

function FleetRow({ host, containers, generatedAt }: { host: HostOverview; containers: ContainerOverview[]; generatedAt: string }) {
  const memory = percent(host.memoryTotalBytes, host.memoryAvailableBytes);
  const disk = percent(host.diskTotalBytes, host.diskAvailableBytes);
  const hostContainers = containers.filter((item) => item.hostId === host.id);
  return <div className={styles.fleetRow}>
    <div className={styles.nodeName}><span className={styles.nodeIcon}>⌁</span><div><strong>{host.displayName}</strong><small>{host.provider} · {host.environment}</small></div></div>
    <StatusBadge tone={toneFor(host.status)}>{statusText[host.status]}</StatusBadge>
    <div className={styles.barStat}><span>MEM</span><div><i style={{ width: `${memory ?? 0}%` }} /></div><b>{memory === null ? "—" : `${memory}%`}</b></div>
    <div className={styles.barStat}><span>DISK</span><div><i style={{ width: `${disk ?? 0}%` }} /></div><b>{disk === null ? "—" : `${disk}%`}</b></div>
    <div className={styles.nodeMeta}><strong>{hostContainers.length}</strong><small>containers</small></div>
    <div className={styles.nodeMeta}><strong>{host.loadAverage1?.toFixed(2) ?? "—"}</strong><small>load 1m</small></div>
    <time>{relative(host.receivedAt, generatedAt)}</time>
  </div>;
}

function EventItem({ activity, generatedAt }: { activity: OverviewActivity; generatedAt: string }) {
  return <a className={styles.event} href={activity.href}><span className={styles.eventRail} data-tone={activity.tone} /><div><strong>{activity.title}</strong><p>{activity.detail}</p></div><time>{relative(activity.occurredAt, generatedAt)}</time></a>;
}

export function OverviewDashboard({ data }: { data: OverviewSnapshot }) {
  const [range, setRange] = useState("24h");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const hosts = data.monitoring?.hosts ?? [];
  const containers = data.monitoring?.containers ?? [];
  const filteredHosts = useMemo(() => hosts.filter((host) => host.displayName.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || host.status === filter)), [hosts, query, filter]);
  const online = hosts.filter((host) => host.status === "online").length;
  const health = data.status.reliability === "operational" ? "ALL SYSTEMS OPERATIONAL" : "ACTION REQUIRED";
  return <>
    <AutoRefresh intervalMs={30_000} />
    <main className={styles.dashboard}>
      <header className={styles.hero}><div><p className={styles.kicker}>IVRM / OPERATIONS CONTROL</p><h1>Overview</h1><p className={styles.heroCopy}>Real-time fleet telemetry and service health across your infrastructure.</p></div><div className={styles.heroActions}><span className={styles.live}><i /> LIVE · {relative(data.generatedAt, data.generatedAt)}</span><ActionLink href="/incidents" variant="primary">Open incidents</ActionLink></div></header>
      <div className={styles.toolbar}><div className={styles.rangeGroup} aria-label="Time range">{["1h", "6h", "24h", "7d"].map((item) => <button key={item} className={range === item ? styles.activeControl : ""} onClick={() => setRange(item)}>{item}</button>)}</div><button className={styles.command}>⌘K <span>Command menu</span></button><button className={styles.auto} onClick={() => setAutoScroll(!autoScroll)}><i data-on={autoScroll} /> Auto-scroll</button></div>
      <section className={styles.healthBand}><div><span className={styles.healthMark}>✓</span><div><strong>{health}</strong><small>Last snapshot {relative(data.generatedAt, data.generatedAt)} · All regions reporting</small></div></div><span className={styles.healthTime}>30s refresh</span></section>
      <section className={styles.metrics} aria-label="Key metrics"><Metric label="HOSTS ONLINE" value={`${online}/${hosts.length}`} detail="Fleet availability" values={[.42,.48,.45,.56,.52,.6,.58,.64]} tone={online === hosts.length ? "success" : "warning"} /><Metric label="ACTIVE INCIDENTS" value={`${data.incidents?.summary.activeCount ?? "—"}`} detail="Across all services" values={[.2,.18,.25,.21,.28,.22,.3,.27]} tone={data.attention.activeCritical ? "danger" : "neutral"} /><Metric label="MEMORY USAGE" value={data.monitoring && hosts.length ? `${Math.round(hosts.reduce((sum, host) => sum + (percent(host.memoryTotalBytes, host.memoryAvailableBytes) ?? 0), 0) / hosts.length)}%` : "—"} detail="Fleet average" values={[.55,.58,.5,.62,.57,.65,.6,.66]} /><Metric label="CONTAINERS" value={`${containers.filter((item) => item.status === "online").length}/${containers.length}`} detail="Running workloads" values={[.7,.72,.69,.74,.76,.75,.78,.8]} tone="info" /></section>
      <div className={styles.mainGrid}><section className={styles.panel}><div className={styles.panelHeader}><div><p className={styles.kicker}>PERFORMANCE / {range.toUpperCase()}</p><h2>System performance</h2></div><span className={styles.legend}><i /> CPU <i className={styles.legendBlue} /> MEMORY</span></div><div className={styles.chart}><div className={styles.chartLabels}><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div><div className={styles.chartBody}><div className={styles.gridLines} /><svg viewBox="0 0 600 180" preserveAspectRatio="none" aria-label="Performance trend"><polyline points="0,112 80,95 160,118 240,74 320,92 400,54 480,68 600,44" className={styles.chartLine} /><polyline points="0,140 80,126 160,132 240,106 320,114 400,94 480,104 600,84" className={styles.chartLineBlue} /></svg></div></div></section><section className={styles.panel}><div className={styles.panelHeader}><div><p className={styles.kicker}>SERVICE HEALTH</p><h2>Cluster status</h2></div><ActionLink href="/reliability">View all</ActionLink></div><div className={styles.serviceList}>{[["Minecraft","/minecraft",data.status.minecraft,"Public & backend probes"],["Infrastructure","/inventory",data.status.infrastructure,`${hosts.length} hosts · ${containers.length} containers`],["Backup","/backups?range=24h",data.status.backup,"Protection window 24h"],["Notifications","/notifications",data.status.notifications,"Delivery pipeline"]].map(([name, href, status, detail]) => <a href={href as string} className={styles.service} key={name as string}><span className={styles.servicePulse} data-tone={toneFor(status as string)} /><div><strong>{name as string}</strong><small>{detail as string}</small></div><StatusBadge tone={toneFor(status as string)}>{statusText[status as string] ?? "OPERATIONAL"}</StatusBadge><span>→</span></a>)}</div></section></div>
      <div className={styles.lowerGrid}><section className={styles.panel}><div className={styles.panelHeader}><div><p className={styles.kicker}>FLEET INVENTORY</p><h2>Server fleet <span>{filteredHosts.length}</span></h2></div><div className={styles.fleetControls}><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search fleet..." aria-label="Search fleet" /><select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter fleet"><option value="all">All status</option><option value="online">Online</option><option value="stale">Stale</option><option value="offline">Offline</option></select></div></div><div className={styles.fleetTable}>{filteredHosts.length ? filteredHosts.map((host) => <FleetRow key={host.id} host={host} containers={containers} generatedAt={data.generatedAt} />) : <StatePanel title="No matching hosts" />}</div></section><section className={styles.panel}><div className={styles.panelHeader}><div><p className={styles.kicker}>EVENT STREAM</p><h2>Recent activity</h2></div><span className={styles.live}>● LIVE</span></div><div className={styles.events}>{data.activities.length ? data.activities.map((item) => <EventItem key={item.id} activity={item} generatedAt={data.generatedAt} />) : <StatePanel title="No recent activity" />}</div></section></div>
    </main>
  </>;
}
