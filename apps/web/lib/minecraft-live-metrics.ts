// Minecraft ライブメトリクス（Herta #857 P4 / #862 Q4）
// status.ivrm.jp で公開される metrics-live.json / metrics-history.json /
// reports.json をサーバー側で取得する。取得できない場合は null を返し、
// 画面側は節ごと隠す。

export type LiveServerMetrics = {
  state: string;
  cpuPct: number | null;
  memPct: number | null;
  memBytes: number | null;
  diskReadBps: number | null;
  diskWriteBps: number | null;
};

export type LiveMetricSeries = {
  key: string;
  label: string;
  color: string;
  cpu: (number | null)[];
  memory: (number | null)[];
};

export type LiveRangeId = "30m" | "2h" | "24h";

export type LiveRangeData = {
  series: LiveMetricSeries[];
  tps: (number | null)[];
};

export type LiveGameMetrics = {
  tps1m: number | null;
  tps5m: number | null;
  tps15m: number | null;
  msptMedian1m: number | null;
  msptP951m: number | null;
};

export type LiveReportEntry = {
  date: string;
  url: string;
  tpsAvg: number | null;
  tpsMin: number | null;
  cpuMaxHost: number | null;
  playersMax: number | null;
};

export type MinecraftLiveMetrics = {
  generatedAt: string | null;
  host: { cpuPct: number | null; memPct: number | null; load1: number | null } | null;
  main: LiveServerMetrics | null;
  resource: LiveServerMetrics | null;
  velocity: LiveServerMetrics | null;
  players: { online: number | null; max: number | null } | null;
  game: LiveGameMetrics | null;
  ranges: Record<LiveRangeId, LiveRangeData>;
  reports: LiveReportEntry[];
};

const SERIES_DEFS = [
  { key: "mc-main", label: "生活サーバー", color: "#57f287" },
  { key: "mc-resource", label: "資源サーバー", color: "#60a5fa" },
  { key: "host", label: "ホスト全体", color: "#f59e0b" },
] as const;

const RANGES: { id: LiveRangeId; tier: string; points: number }[] = [
  { id: "30m", tier: "10s", points: 180 },
  { id: "2h", tier: "10s", points: 720 },
  { id: "24h", tier: "60s", points: 1440 },
];

const FETCH_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function fetchJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function parseServer(value: unknown): LiveServerMetrics | null {
  if (!isRecord(value)) return null;
  return {
    state: typeof value.state === "string" ? value.state : "unknown",
    cpuPct: toNumberOrNull(value.cpuPct),
    memPct: toNumberOrNull(value.memPct),
    memBytes: toNumberOrNull(value.memBytes),
    diskReadBps: toNumberOrNull(value.diskReadBps),
    diskWriteBps: toNumberOrNull(value.diskWriteBps),
  };
}

type HistoryEntry = [number, number | null, number | null];

function sortedEntries(tierSeries: Record<string, unknown>, key: string): HistoryEntry[] {
  const entries = tierSeries[key];
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(
      (entry): entry is HistoryEntry =>
        Array.isArray(entry) && typeof entry[0] === "number",
    )
    .sort((a, b) => a[0] - b[0]);
}

function parseRangeData(
  history: unknown,
  tierName: string,
  maxPoints: number,
): LiveRangeData {
  const empty: LiveRangeData = { series: [], tps: [] };
  if (!isRecord(history) || !isRecord(history.tiers)) return empty;
  const tier = history.tiers[tierName];
  if (!isRecord(tier) || !isRecord(tier.series)) return empty;
  const series: LiveMetricSeries[] = [];
  for (const def of SERIES_DEFS) {
    const sorted = sortedEntries(tier.series, def.key).slice(-maxPoints);
    if (sorted.length < 2) continue;
    series.push({
      key: def.key,
      label: def.label,
      color: def.color,
      cpu: sorted.map((entry) => toNumberOrNull(entry[1])),
      memory: sorted.map((entry) => toNumberOrNull(entry[2])),
    });
  }
  const gameSorted = sortedEntries(tier.series, "game").slice(-maxPoints);
  const tps =
    gameSorted.length >= 2
      ? gameSorted.map((entry) => toNumberOrNull(entry[1]))
      : [];
  return { series, tps };
}

function parseReports(value: unknown): LiveReportEntry[] {
  if (!Array.isArray(value)) return [];
  const result: LiveReportEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.date !== "string" || typeof item.url !== "string") continue;
    result.push({
      date: item.date,
      url: item.url,
      tpsAvg: toNumberOrNull(item.tpsAvg),
      tpsMin: toNumberOrNull(item.tpsMin),
      cpuMaxHost: toNumberOrNull(item.cpuMaxHost),
      playersMax: toNumberOrNull(item.playersMax),
    });
    if (result.length >= 7) break;
  }
  return result;
}

export async function getMinecraftLiveMetrics(): Promise<MinecraftLiveMetrics | null> {
  const base = (
    process.env.MINECRAFT_STATUS_BASE_URL ?? "https://status.ivrm.jp"
  ).replace(/\/$/, "");
  const [live, history, reportsRaw] = await Promise.all([
    fetchJson(`${base}/api/metrics-live.json`),
    fetchJson(`${base}/api/metrics-history.json`),
    fetchJson(`${base}/api/reports.json`),
  ]);
  if (!isRecord(live)) return null;
  const servers = isRecord(live.servers) ? live.servers : {};
  const host = isRecord(live.host)
    ? {
        cpuPct: toNumberOrNull(live.host.cpuPct),
        memPct: toNumberOrNull(live.host.memPct),
        load1: toNumberOrNull(live.host.load1),
      }
    : null;
  const players = isRecord(live.players)
    ? {
        online: toNumberOrNull(live.players.online),
        max: toNumberOrNull(live.players.max),
      }
    : null;
  const game = isRecord(live.game)
    ? {
        tps1m: toNumberOrNull(live.game.tps1m),
        tps5m: toNumberOrNull(live.game.tps5m),
        tps15m: toNumberOrNull(live.game.tps15m),
        msptMedian1m: toNumberOrNull(live.game.msptMedian1m),
        msptP951m: toNumberOrNull(live.game.msptP951m),
      }
    : null;
  const ranges = Object.fromEntries(
    RANGES.map((range) => [
      range.id,
      parseRangeData(history, range.tier, range.points),
    ]),
  ) as Record<LiveRangeId, LiveRangeData>;
  return {
    generatedAt: typeof live.generatedAt === "string" ? live.generatedAt : null,
    host,
    main: parseServer(servers["mc-main"]),
    resource: parseServer(servers["mc-resource"]),
    velocity: parseServer(servers["ivrm-velocity"]),
    players,
    game,
    ranges,
    reports: parseReports(reportsRaw),
  };
}
