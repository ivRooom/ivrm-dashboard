import {
  callSupabaseRpc,
  type HistoryDataSource,
  type HistoryRange,
} from "./history";

export type MinecraftMetricHistoryPoint = {
  timestamp: string;
  publicOnline: number | null;
  backendOnline: number | null;
  publicLatencyMs: number | null;
  backendLatencyMs: number | null;
  tps1m: number | null;
  tps5m: number | null;
  tps15m: number | null;
  msptMedian1m: number | null;
  msptP95_1m: number | null;
  msptMax1m: number | null;
  performanceSampleCount: number;
  sampleCount: number;
};

export type MinecraftMetricHistorySeries = {
  hostId: string;
  hostDisplayName: string;
  dataSource: HistoryDataSource;
  bucketSeconds: number;
  points: MinecraftMetricHistoryPoint[];
};

type MinecraftMetricHistoryRow = {
  host_id: unknown;
  host_display_name: unknown;
  data_source: unknown;
  bucket_seconds: unknown;
  points: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableNonNegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function dataSource(value: unknown): HistoryDataSource | null {
  return value === "raw" || value === "rollup_5m" ? value : null;
}

function parsePoints(value: unknown): MinecraftMetricHistoryPoint[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .flatMap((item): MinecraftMetricHistoryPoint[] => {
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
          publicOnline: nullableNonNegativeNumber(item.publicOnline),
          backendOnline: nullableNonNegativeNumber(item.backendOnline),
          publicLatencyMs: nullableNonNegativeNumber(item.publicLatencyMs),
          backendLatencyMs: nullableNonNegativeNumber(item.backendLatencyMs),
          tps1m: nullableNonNegativeNumber(item.tps1m),
          tps5m: nullableNonNegativeNumber(item.tps5m),
          tps15m: nullableNonNegativeNumber(item.tps15m),
          msptMedian1m: nullableNonNegativeNumber(item.msptMedian1m),
          msptP95_1m: nullableNonNegativeNumber(item.msptP95_1m),
          msptMax1m: nullableNonNegativeNumber(item.msptMax1m),
          performanceSampleCount: nonNegativeInteger(item.performanceSampleCount),
          sampleCount: nonNegativeInteger(item.sampleCount),
        },
      ];
    })
    .sort(
      (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
    );
}

export async function getMinecraftMetricHistory(
  range: HistoryRange,
): Promise<MinecraftMetricHistorySeries[]> {
  const payload = await callSupabaseRpc<unknown[]>(
    "get_minecraft_metric_history_v1",
    { p_range: range },
  );

  if (!Array.isArray(payload)) {
    throw new Error("Minecraft履歴RPCが配列以外を返しました");
  }

  return payload
    .flatMap((raw): MinecraftMetricHistorySeries[] => {
      if (!isRecord(raw)) {
        return [];
      }
      const row = raw as MinecraftMetricHistoryRow;
      const bucketSeconds = positiveInteger(row.bucket_seconds);
      const source = dataSource(row.data_source);
      if (
        typeof row.host_id !== "string" ||
        typeof row.host_display_name !== "string" ||
        !bucketSeconds ||
        !source
      ) {
        return [];
      }
      return [
        {
          hostId: row.host_id,
          hostDisplayName: row.host_display_name,
          dataSource: source,
          bucketSeconds,
          points: parsePoints(row.points),
        },
      ];
    })
    .sort((left, right) =>
      left.hostDisplayName.localeCompare(right.hostDisplayName, "ja"),
    );
}
