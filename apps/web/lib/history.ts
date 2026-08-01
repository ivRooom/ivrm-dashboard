export type ContainerMetricHistoryPoint = {
  timestamp: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  sampleCount: number;
};

export type ContainerMetricHistorySeries = {
  hostId: string;
  hostDisplayName: string;
  containerName: string;
  points: ContainerMetricHistoryPoint[];
};

type ContainerMetricHistoryRow = {
  host_id: string;
  host_display_name: string;
  container_name: string;
  bucket_at: string;
  cpu_percent: number | null;
  memory_percent: number | null;
  sample_count: number;
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

export async function getContainerMetricHistory(
  hours = 24,
  bucketSeconds = 300,
): Promise<ContainerMetricHistorySeries[]> {
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
    throw new Error("履歴期間が不正です");
  }
  if (
    !Number.isInteger(bucketSeconds) ||
    bucketSeconds < 60 ||
    bucketSeconds > 3_600
  ) {
    throw new Error("履歴の集約粒度が不正です");
  }
  if (Math.ceil((hours * 3_600) / bucketSeconds) > 2_000) {
    throw new Error("履歴の取得バケット数が上限を超えています");
  }

  const { url, serviceRoleKey } = supabaseConfiguration();
  const response = await fetch(
    `${url}/rest/v1/rpc/get_container_metric_history`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        p_hours: hours,
        p_bucket_seconds: bucketSeconds,
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`Supabase履歴APIが${response.status}を返しました`);
  }

  const rows = (await response.json()) as ContainerMetricHistoryRow[];
  const seriesByKey = new Map<string, ContainerMetricHistorySeries>();

  for (const row of rows) {
    const key = `${row.host_id}:${row.container_name}`;
    const series = seriesByKey.get(key) ?? {
      hostId: row.host_id,
      hostDisplayName: row.host_display_name,
      containerName: row.container_name,
      points: [],
    };

    series.points.push({
      timestamp: row.bucket_at,
      cpuPercent: row.cpu_percent,
      memoryPercent: row.memory_percent,
      sampleCount: Number(row.sample_count),
    });
    seriesByKey.set(key, series);
  }

  return [...seriesByKey.values()]
    .map((series) => ({
      ...series,
      points: series.points.sort(
        (left, right) =>
          Date.parse(left.timestamp) - Date.parse(right.timestamp),
      ),
    }))
    .sort((left, right) =>
      `${left.hostDisplayName}:${left.containerName}`.localeCompare(
        `${right.hostDisplayName}:${right.containerName}`,
        "ja",
      ),
    );
}
