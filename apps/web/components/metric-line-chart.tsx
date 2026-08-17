import { LatestHorizontalScroller } from "./latest-horizontal-scroller";
import styles from "./metric-line-chart.module.css";

type MetricChartPoint = {
  timestamp: string;
  value: number | null;
};

type MetricChartSeries = {
  id: string;
  label: string;
  points: MetricChartPoint[];
};

export type MetricChartMarker = {
  id: string;
  timestamp: string;
  label: string;
  severity: "info" | "warning" | "critical" | "recovery";
};

export type MetricChartRegionKind =
  | "stale"
  | "offline"
  | "error"
  | "maintenance";

export type MetricChartRegion = {
  id: string;
  startAt: string;
  endAt: string;
  label: string;
  kind: MetricChartRegionKind;
};

type MetricLineChartProps = {
  title: string;
  description: string;
  series: MetricChartSeries[];
  startAt: string;
  endAt: string;
  expectedIntervalSeconds: number;
  aggregationLabel: string;
  periodLabel: string;
  unit: string;
  maximum?: number;
  valueDigits?: number;
  emptyDescription?: string;
  markers?: MetricChartMarker[];
  regions?: MetricChartRegion[];
};

type PositionedPoint = {
  timestamp: number;
  x: number;
  y: number;
  value: number;
};

const WIDTH = 960;
const HEIGHT = 300;
const PADDING = { top: 22, right: 20, bottom: 38, left: 58 };
const PLOT_WIDTH = WIDTH - PADDING.left - PADDING.right;
const PLOT_HEIGHT = HEIGHT - PADDING.top - PADDING.bottom;
const SERIES_HUE_STEP = 47;

const markerClasses: Record<MetricChartMarker["severity"], string> = {
  info: styles.markerInfo,
  warning: styles.markerWarning,
  critical: styles.markerCritical,
  recovery: styles.markerRecovery,
};

const regionClasses: Record<MetricChartRegionKind, string> = {
  stale: styles.regionStale,
  offline: styles.regionOffline,
  error: styles.regionError,
  maintenance: styles.regionMaintenance,
};

const regionLabels: Record<MetricChartRegionKind, string> = {
  stale: "Stale",
  offline: "Offline",
  error: "Error",
  maintenance: "Maintenance",
};

function seriesColor(index: number): string {
  return `hsl(${(index * SERIES_HUE_STEP + 84) % 360}deg 72% 60%)`;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo",
  }).format(new Date(timestamp));
}

function formatValue(
  value: number,
  unit: string,
  valueDigits?: number,
): string {
  const digits = valueDigits ?? (value >= 10 ? 1 : 2);
  return `${value.toFixed(digits)}${unit}`;
}

function splitSegments(
  points: PositionedPoint[],
  expectedIntervalSeconds: number,
): PositionedPoint[][] {
  const segments: PositionedPoint[][] = [];
  let current: PositionedPoint[] = [];
  const maximumGapMilliseconds = expectedIntervalSeconds * 1.1 * 1_000;

  for (const point of points) {
    const previous = current.at(-1);
    if (
      previous &&
      point.timestamp - previous.timestamp > maximumGapMilliseconds
    ) {
      segments.push(current);
      current = [];
    }
    current.push(point);
  }

  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

export function MetricLineChart({
  title,
  description,
  series,
  startAt,
  endAt,
  expectedIntervalSeconds,
  aggregationLabel,
  periodLabel,
  unit,
  maximum,
  valueDigits,
  emptyDescription = "選択期間に有効なサンプルが取得されると自動的に表示されます。",
  markers = [],
  regions = [],
}: MetricLineChartProps) {
  const startMilliseconds = Date.parse(startAt);
  const endMilliseconds = Date.parse(endAt);
  const duration = Math.max(1, endMilliseconds - startMilliseconds);

  const visibleSeries = series
    .map((item) => ({
      ...item,
      points: item.points
        .map((point) => ({
          timestamp: Date.parse(point.timestamp),
          value: point.value,
        }))
        .filter(
          (point): point is { timestamp: number; value: number } =>
            Number.isFinite(point.timestamp) &&
            point.timestamp >= startMilliseconds &&
            point.timestamp <= endMilliseconds &&
            point.value !== null &&
            Number.isFinite(point.value),
        )
        .sort((left, right) => left.timestamp - right.timestamp),
    }))
    .filter((item) => item.points.length > 0);

  const visibleMarkers = markers
    .map((marker) => ({ ...marker, time: Date.parse(marker.timestamp) }))
    .filter(
      (marker) =>
        Number.isFinite(marker.time) &&
        marker.time >= startMilliseconds &&
        marker.time <= endMilliseconds,
    )
    .sort((left, right) => left.time - right.time);

  const visibleRegions = regions
    .map((region) => ({
      ...region,
      start: Math.max(Date.parse(region.startAt), startMilliseconds),
      end: Math.min(Date.parse(region.endAt), endMilliseconds),
    }))
    .filter(
      (region) =>
        Number.isFinite(region.start) &&
        Number.isFinite(region.end) &&
        region.end > region.start,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const visibleRegionKinds = [
    ...new Set(visibleRegions.map((region) => region.kind)),
  ];

  const values = visibleSeries.flatMap((item) =>
    item.points.map((point) => point.value),
  );
  const observedMaximum = values.length > 0 ? Math.max(...values) : 0;
  const yMaximum =
    maximum ?? Math.max(1, Math.ceil(observedMaximum * 1.15 * 10) / 10);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(
    (ratio) => yMaximum * ratio,
  );
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map(
    (ratio) => startMilliseconds + duration * ratio,
  );
  const firstDataTimestamp = visibleSeries.reduce<number | null>(
    (earliest, item) => {
      const first = item.points[0]?.timestamp;
      if (first === undefined) {
        return earliest;
      }
      return earliest === null ? first : Math.min(earliest, first);
    },
    null,
  );
  const hasLateDataStart =
    firstDataTimestamp !== null &&
    firstDataTimestamp - startMilliseconds > expectedIntervalSeconds * 1.5 * 1_000;

  return (
    <article className={styles.card}>
      <div className={styles.heading}>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <span>{aggregationLabel}</span>
      </div>

      {visibleSeries.length === 0 ? (
        <div className={styles.empty}>
          <strong>グラフ化できるデータがありません</strong>
          <p>{emptyDescription}</p>
        </div>
      ) : (
        <>
          {hasLateDataStart && firstDataTimestamp !== null ? (
            <p className={styles.coverageNote}>
              表示期間内のデータ開始: {formatTime(firstDataTimestamp)}
            </p>
          ) : null}

          <LatestHorizontalScroller ariaLabel={title}>
            <svg
              className={styles.chart}
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              role="img"
              aria-label={`${title}。${visibleSeries.map((item) => item.label).join("、")}の直近${periodLabel}の推移。状態期間${visibleRegions.length}件、イベントマーカー${visibleMarkers.length}件`}
            >
              <title>{title}</title>

              {visibleRegions.map((region) => {
                const x =
                  PADDING.left +
                  ((region.start - startMilliseconds) / duration) * PLOT_WIDTH;
                const endX =
                  PADDING.left +
                  ((region.end - startMilliseconds) / duration) * PLOT_WIDTH;
                return (
                  <g key={region.id}>
                    <title>{`${region.label} / ${formatTime(region.start)}〜${formatTime(region.end)}`}</title>
                    <rect
                      className={`${styles.statusRegion} ${regionClasses[region.kind]}`}
                      height={PLOT_HEIGHT}
                      width={Math.max(1.5, endX - x)}
                      x={x}
                      y={PADDING.top}
                    />
                  </g>
                );
              })}

              {yTicks.map((tick) => {
                const y =
                  PADDING.top +
                  PLOT_HEIGHT -
                  (tick / Math.max(yMaximum, 1)) * PLOT_HEIGHT;
                return (
                  <g key={tick}>
                    <line
                      className={styles.gridLine}
                      x1={PADDING.left}
                      x2={WIDTH - PADDING.right}
                      y1={y}
                      y2={y}
                    />
                    <text
                      className={styles.axisLabel}
                      x={PADDING.left - 10}
                      y={y + 4}
                      textAnchor="end"
                    >
                      {formatValue(tick, unit, valueDigits)}
                    </text>
                  </g>
                );
              })}

              {xTicks.map((tick, index) => {
                const x =
                  PADDING.left +
                  ((tick - startMilliseconds) / duration) * PLOT_WIDTH;
                return (
                  <g key={tick}>
                    <line
                      className={`${styles.gridLine} ${styles.verticalGridLine}`}
                      x1={x}
                      x2={x}
                      y1={PADDING.top}
                      y2={HEIGHT - PADDING.bottom}
                    />
                    <text
                      className={styles.axisLabel}
                      x={x}
                      y={HEIGHT - 12}
                      textAnchor={
                        index === 0
                          ? "start"
                          : index === xTicks.length - 1
                            ? "end"
                            : "middle"
                      }
                    >
                      {formatTime(tick)}
                    </text>
                  </g>
                );
              })}

              {visibleMarkers.map((marker) => {
                const x =
                  PADDING.left +
                  ((marker.time - startMilliseconds) / duration) * PLOT_WIDTH;
                return (
                  <g key={marker.id}>
                    <title>{`${marker.label} / ${formatTime(marker.time)}`}</title>
                    <line
                      className={`${styles.eventMarker} ${markerClasses[marker.severity]}`}
                      x1={x}
                      x2={x}
                      y1={PADDING.top}
                      y2={HEIGHT - PADDING.bottom}
                    />
                  </g>
                );
              })}

              {visibleSeries.map((item, seriesIndex) => {
                const positionedPoints: PositionedPoint[] = item.points.map(
                  (point) => ({
                    timestamp: point.timestamp,
                    value: point.value,
                    x:
                      PADDING.left +
                      ((point.timestamp - startMilliseconds) / duration) *
                        PLOT_WIDTH,
                    y:
                      PADDING.top +
                      PLOT_HEIGHT -
                      (point.value / Math.max(yMaximum, 1)) * PLOT_HEIGHT,
                  }),
                );
                const segments = splitSegments(
                  positionedPoints,
                  expectedIntervalSeconds,
                );
                const lastPoint = positionedPoints.at(-1);
                const color = seriesColor(seriesIndex);

                return (
                  <g key={item.id}>
                    {segments.map((segment, segmentIndex) => {
                      if (segment.length === 1) {
                        const point = segment[0];
                        return (
                          <circle
                            className={styles.point}
                            cx={point.x}
                            cy={point.y}
                            key={`${item.id}-${segmentIndex}`}
                            r="3"
                            style={{ fill: color, stroke: color }}
                          />
                        );
                      }

                      const path = segment
                        .map(
                          (point, pointIndex) =>
                            `${pointIndex === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`,
                        )
                        .join(" ");
                      return (
                        <path
                          className={styles.line}
                          d={path}
                          key={`${item.id}-${segmentIndex}`}
                          style={{ stroke: color }}
                        />
                      );
                    })}
                    {lastPoint ? (
                      <circle
                        className={styles.lastPoint}
                        cx={lastPoint.x}
                        cy={lastPoint.y}
                        r="4"
                        style={{ stroke: color }}
                      />
                    ) : null}
                  </g>
                );
              })}
            </svg>
          </LatestHorizontalScroller>

          <div className={styles.legend} aria-label={`${title}の凡例`}>
            {visibleSeries.map((item, index) => {
              const valuesForSeries = item.points.map((point) => point.value);
              const latest = valuesForSeries.at(-1) ?? 0;
              const minimum = Math.min(...valuesForSeries);
              const peak = Math.max(...valuesForSeries);
              return (
                <div className={styles.legendItem} key={item.id}>
                  <i style={{ background: seriesColor(index) }} />
                  <div>
                    <strong>{item.label}</strong>
                    <span>
                      最新 {formatValue(latest, unit, valueDigits)} / 最小{" "}
                      {formatValue(minimum, unit, valueDigits)} / 最大{" "}
                      {formatValue(peak, unit, valueDigits)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          {visibleRegionKinds.length > 0 ? (
            <div className={styles.regionLegend} aria-label="状態期間Overlayの凡例">
              {visibleRegionKinds.map((kind) => (
                <span key={kind}>
                  <i
                    aria-hidden="true"
                    className={`${styles.regionSwatch} ${regionClasses[kind]}`}
                  />
                  {regionLabels[kind]}
                </span>
              ))}
              <small>背景帯は該当状態が継続した期間です。</small>
            </div>
          ) : null}
          {visibleMarkers.length > 0 ? (
            <p className={styles.markerHint}>
              縦の破線はState / Health / Restart / OOMなどの監視イベントです（{visibleMarkers.length}件）。
            </p>
          ) : null}
        </>
      )}
    </article>
  );
}
