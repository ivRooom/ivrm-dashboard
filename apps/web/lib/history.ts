export const HISTORY_RANGE_CONFIG = {
  "1h": {
    label: "1時間",
    hours: 1,
    bucketSeconds: 60,
    aggregationLabel: "1分平均",
    refreshMs: 60_000,
  },
  "6h": {
    label: "6時間",
    hours: 6,
    bucketSeconds: 120,
    aggregationLabel: "2分平均",
    refreshMs: 60_000,
  },
  "24h": {
    label: "24時間",
    hours: 24,
    bucketSeconds: 300,
    aggregationLabel: "5分平均",
    refreshMs: 60_000,
  },
  "7d": {
    label: "7日",
    hours: 168,
    bucketSeconds: 1_800,
    aggregationLabel: "30分平均",
    refreshMs: 300_000,
  },
  "30d": {
    label: "30日",
    hours: 720,
    bucketSeconds: 3_600,
    aggregationLabel: "1時間平均",
    refreshMs: 300_000,
  },
} as const;

export type HistoryRange = keyof typeof HISTORY_RANGE_CONFIG;
export type HistoryDataSource = "raw" | "rollup_5m";

export type HostMetricHistoryPoint = {
  timestamp: string;
  loadAverage1: number | null;
  loadAverage5: number | null;
  loadAverage15: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  sampleCount: number;
};

export type HostMetricHistorySeries = {
  hostId: string;
  hostDisplayName: string;
  dataSource: HistoryDataSource;
  bucketSeconds: number;
  points: HostMetricHistoryPoint[];
};

export type ContainerMetricHistoryPoint = {
  timestamp: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  pids: number | null;
  restartCount: number | null;
  networkRxRateBps: number | null;
  networkTxRateBps: number | null;
  blockReadRateBps: number | null;
  blockWriteRateBps: number | null;
  sampleCount: number;
};

export type ContainerMetricHistorySeries = {
  hostId: string;
  hostDisplayName: string;
  containerName: string;
  dataSource: HistoryDataSource;
  bucketSeconds: number;
  points: ContainerMetricHistoryPoint[];
};

type HostMetricHistoryRow = {
  host_id: string;
  host_display_name: string;
  data_source: string;
  bucket_seconds: number;
  points: unknown;
};

type ContainerMetricHistoryRow = {
  host_id: string;
  host_display_name: string;
  container_name: string;
  data_source: string;
  bucket_seconds: number;
  points: unknown;
};

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name}が設定されていません`);
  }
  return value;
}

function supabaseConfiguration(): { url: string; serviceRoleKey: string } {
  return {
    url: requireEnvironment("SUPABASE_URL").replace(/\/$/, ""),
    serviceRoleKey: requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function dataSource(value: unknown): HistoryDataSource {
  return value === "rollup_5m" ? "rollup_5m" : "raw";
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return value;
}

export function parseHistoryRange(value: string | null | undefined): HistoryRange {
  return value && Object.hasOwn(HISTORY_RANGE_CONFIG, value)
    ? (value as HistoryRange)
    : "24h";
}

async function callHistoryRpc<T>(rpcName: string, range: HistoryRange): Promise<T> {
  const { url, serviceRoleKey } = supabaseConfiguration();
  const response = await fetch(`${url}/rest/v1/rpc/${rpcName}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ p_range: range }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`${rpcName}が${response.status}を返しました`);
  }
  return (await response.json()) as T;
}

function parseHostPoints(value: unknown): HostMetricHistoryPoint[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .flatMap((item): HostMetricHistoryPoint[] => {
      if (!isRecord(item)) {
        return [];
      }
      const parsedTimestamp = timestamp(item.timestamp);
      if (!parsedTimestamp) {
        return [];
      }
      return [
        {
          timestamp: parsedTimestamp,
          loadAverage1: nullableNumber(item.loadAverage1),
          loadAverage5: nullableNumber(item.loadAverage5),
          loadAverage15: nullableNumber(item.loadAverage15),
          memoryPercent: nullableNumber(item.memoryPercent),
          diskPercent: nullableNumber(item.diskPercent),
          sampleCount: nonNegativeInteger(item.sampleCount),
        },
      ];
    })
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

function parseContainerPoints(value: unknown): ContainerMetricHistoryPoint[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .flatMap((item): ContainerMetricHistoryPoint[] => {
      if (!isRecord(item)) {
        return [];
      }
      const parsedTimestamp = timestamp(item.timestamp);
      if (!parsedTimestamp) {
        return [];
      }
      return [
        {
          timestamp: parsedTimestamp,
          cpuPercent: nullableNumber(item.cpuPercent),
          memoryPercent: nullableNumber(item.memoryPercent),
          pids: nullableNumber(item.pids),
          restartCount: nullableNumber(item.restartCount),
          networkRxRateBps: nullableNumber(item.networkRxRateBps),
          networkTxRateBps: nullableNumber(item.networkTxRateBps),
          blockReadRateBps: nullableNumber(item.blockReadRateBps),
          blockWriteRateBps: nullableNumber(item.blockWriteRateBps),
          sampleCount: nonNegativeInteger(item.sampleCount),
        },
      ];
    })
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

export async function getHostMetricHistory(
  range: HistoryRange,
): Promise<HostMetricHistorySeries[]> {
  const rows = await callHistoryRpc<HostMetricHistoryRow[]>(
    "get_host_metric_history_v3",
    range,
  );

  return rows
    .filter(
      (row) =>
        typeof row.host_id === "string" &&
        typeof row.host_display_name === "string" &&
        Number.isInteger(Number(row.bucket_seconds)),
    )
    .map((row) => ({
      hostId: row.host_id,
      hostDisplayName: row.host_display_name,
      dataSource: dataSource(row.data_source),
      bucketSeconds: Number(row.bucket_seconds),
      points: parseHostPoints(row.points),
    }))
    .sort((left, right) =>
      left.hostDisplayName.localeCompare(right.hostDisplayName, "ja"),
    );
}

export async function getContainerMetricHistory(
  range: HistoryRange,
): Promise<ContainerMetricHistorySeries[]> {
  const rows = await callHistoryRpc<ContainerMetricHistoryRow[]>(
    "get_container_metric_history_v3",
    range,
  );

  return rows
    .filter(
      (row) =>
        typeof row.host_id === "string" &&
        typeof row.host_display_name === "string" &&
        typeof row.container_name === "string" &&
        Number.isInteger(Number(row.bucket_seconds)),
    )
    .map((row) => ({
      hostId: row.host_id,
      hostDisplayName: row.host_display_name,
      containerName: row.container_name,
      dataSource: dataSource(row.data_source),
      bucketSeconds: Number(row.bucket_seconds),
      points: parseContainerPoints(row.points),
    }))
    .sort((left, right) =>
      `${left.hostDisplayName}:${left.containerName}`.localeCompare(
        `${right.hostDisplayName}:${right.containerName}`,
        "ja",
      ),
    );
}
