// Minecraft ライブメトリクス（Herta #857 P4）
// status.ivrm.jp で公開される metrics-live.json / metrics-history.json を
// サーバー側で取得する。取得できない場合は null を返し、画面側は節ごと隠す。

export type LiveServerMetrics = {
  state: string;
  cpuPct: number | null;
  memPct: number | null;
  memBytes: number | null;
};

export type LiveMetricSeries = {
  key: string;
  label: string;
  color: string;
  cpu: (number | null)[];
  memory: (number | null)[];
};

export type MinecraftLiveMetrics = {
  generatedAt: string | null;
  host: { cpuPct: number | null; memPct: number | null } | null;
  main: LiveServerMetrics | null;
  resource: LiveServerMetrics | null;
  velocity: LiveServerMetrics | null;
  series: LiveMetricSeries[];
};

const SERIES_DEFS = [
  { key: "mc-main", label: "生活サーバー", color: "#57f287" },
  { key: "mc-resource", label: "資源サーバー", color: "#60a5fa" },
  { key: "host", label: "ホスト全体", color: "#f59e0b" },
] as const;

const MAX_POINTS = 180; // 10秒階層で30分ぶん
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
  };
}

function parseSeries(history: unknown): LiveMetricSeries[] {
  if (!isRecord(history) || !isRecord(history.tiers)) return [];
  const tier = history.tiers["10s"];
  if (!isRecord(tier) || !isRecord(tier.series)) return [];
  const result: LiveMetricSeries[] = [];
  for (const def of SERIES_DEFS) {
    const entries = tier.series[def.key];
    if (!Array.isArray(entries) || entries.length < 2) continue;
    const sorted = entries
      .filter(
        (entry): entry is [number, number | null, number | null] =>
          Array.isArray(entry) && typeof entry[0] === "number",
      )
      .sort((a, b) => a[0] - b[0])
      .slice(-MAX_POINTS);
    if (sorted.length < 2) continue;
    result.push({
      key: def.key,
      label: def.label,
      color: def.color,
      cpu: sorted.map((entry) => toNumberOrNull(entry[1])),
      memory: sorted.map((entry) => toNumberOrNull(entry[2])),
    });
  }
  return result;
}

export async function getMinecraftLiveMetrics(): Promise<MinecraftLiveMetrics | null> {
  const base = (
    process.env.MINECRAFT_STATUS_BASE_URL ?? "https://status.ivrm.jp"
  ).replace(/\/$/, "");
  const [live, history] = await Promise.all([
    fetchJson(`${base}/api/metrics-live.json`),
    fetchJson(`${base}/api/metrics-history.json`),
  ]);
  if (!isRecord(live)) return null;
  const servers = isRecord(live.servers) ? live.servers : {};
  const host = isRecord(live.host)
    ? {
        cpuPct: toNumberOrNull(live.host.cpuPct),
        memPct: toNumberOrNull(live.host.memPct),
      }
    : null;
  return {
    generatedAt: typeof live.generatedAt === "string" ? live.generatedAt : null,
    host,
    main: parseServer(servers["mc-main"]),
    resource: parseServer(servers["mc-resource"]),
    velocity: parseServer(servers["ivrm-velocity"]),
    series: parseSeries(history),
  };
}
