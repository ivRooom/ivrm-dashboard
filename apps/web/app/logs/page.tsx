import {
  ActionLink,
  MetricCard,
  MetricGrid,
  PageContent,
  PageHeader,
  StatePanel,
  StatusBadge,
} from "../../components/console-ui";
import { LogViewer } from "../../components/log-viewer";
import {
  CONSOLE_LOG_INITIAL_LIMITS,
  CONSOLE_LOG_LEVELS,
  CONSOLE_LOG_RANGES,
  CONSOLE_LOG_SOURCES,
  getConsoleLogRangeMinutes,
  getConsoleLogSource,
  isConsoleLogInitialLimit,
  isConsoleLogLevel,
  isConsoleLogRange,
  type ConsoleLogInitialLimit,
  type ConsoleLogLevel,
  type ConsoleLogRange,
  type ConsoleLogSourceName,
} from "../../lib/console-log-types";
import { getConsoleLogs, type ConsoleLogEntry } from "../../lib/logs";
import styles from "./logs.module.css";

export const dynamic = "force-dynamic";

const DEFAULT_SERVER_ID = "oci-minecraft-01";
const DEFAULT_RANGE: ConsoleLogRange = "24h";
const DEFAULT_LIMIT: ConsoleLogInitialLimit = 300;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}

export default async function LogsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const sourceValue = firstValue(params.source);
  const levelValue = firstValue(params.level);
  const rangeValue = firstValue(params.range) ?? DEFAULT_RANGE;
  const rawLimit = Number(firstValue(params.limit) ?? DEFAULT_LIMIT);
  const queryValue = firstValue(params.q)?.trim() || null;
  const sourceName: ConsoleLogSourceName | null =
    sourceValue && sourceValue !== "all" && getConsoleLogSource(sourceValue)
      ? (sourceValue as ConsoleLogSourceName)
      : null;
  const level: ConsoleLogLevel | null =
    levelValue && levelValue !== "all" && isConsoleLogLevel(levelValue)
      ? levelValue
      : null;
  const range: ConsoleLogRange = isConsoleLogRange(rangeValue) ? rangeValue : DEFAULT_RANGE;
  const initialLimit: ConsoleLogInitialLimit = isConsoleLogInitialLimit(rawLimit)
    ? rawLimit
    : DEFAULT_LIMIT;
  const query = queryValue && queryValue.length <= 80 ? queryValue : null;
  const selectedRange = CONSOLE_LOG_RANGES.find((item) => item.value === range)!;

  let entries: ConsoleLogEntry[] = [];
  let loadError = false;
  try {
    entries = await getConsoleLogs({
      serverId: DEFAULT_SERVER_ID,
      sourceName,
      level,
      query,
      windowMinutes: getConsoleLogRangeMinutes(range),
      limit: initialLimit,
    });
  } catch (error) {
    loadError = true;
    console.error("Console Logの取得に失敗しました", error);
  }

  const warningOrHigherCount = entries.filter((entry) =>
    ["warning", "error", "critical"].includes(entry.level),
  ).length;
  const latest = entries.at(-1) ?? null;
  const viewerKey = [sourceName ?? "all", level ?? "all", range, initialLimit, query ?? ""].join(":");

  return (
    <PageContent className={styles.content}>
      <PageHeader
        className={styles.pageHeader}
        eyebrow="READ-ONLY LOG STREAM"
        title="ログ"
        description="OCI上のMinecraft・Velocity・Agentログを、機密情報を除去した短期ストリームとして確認します。任意Shell・Docker Socket・SSH・RCONはBrowserへ公開しません。"
        actions={
          <>
            <StatusBadge tone="info">READ ONLY / 24H</StatusBadge>
            <ActionLink href="/events">構造化イベント</ActionLink>
            <ActionLink href="/operations">操作基盤</ActionLink>
          </>
        }
      />

      <MetricGrid className={styles.metricGrid} label="Log Viewerサマリー">
        <MetricCard
          label="表示行"
          value={loadError ? "—" : entries.length}
          detail={`初回最大${initialLimit}行 / Follow中最大800行`}
        />
        <MetricCard
          label="表示期間"
          value={selectedRange.label}
          detail="保存期間は最大24時間"
          tone="info"
        />
        <MetricCard
          label="WARNING+"
          value={loadError ? "—" : warningOrHigherCount}
          detail="warning / error / critical"
          tone={warningOrHigherCount > 0 ? "warning" : "neutral"}
        />
        <MetricCard
          label="最新SOURCE"
          value={latest ? latest.sourceName : "—"}
          detail={latest ? formatDateTime(latest.observedAt) : "Log Report待機中"}
        />
      </MetricGrid>

      <form className={styles.filters} method="get" aria-label="ログフィルター">
        <label>
          <span>Source</span>
          <select defaultValue={sourceName ?? "all"} name="source">
            <option value="all">すべて</option>
            {CONSOLE_LOG_SOURCES.map((source) => (
              <option key={source.name} value={source.name}>
                {source.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Level</span>
          <select defaultValue={level ?? "all"} name="level">
            <option value="all">すべて</option>
            {CONSOLE_LOG_LEVELS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>表示期間</span>
          <select defaultValue={range} name="range">
            {CONSOLE_LOG_RANGES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>最新N行</span>
          <select defaultValue={String(initialLimit)} name="limit">
            {CONSOLE_LOG_INITIAL_LIMITS.map((item) => (
              <option key={item} value={item}>
                {item}行
              </option>
            ))}
          </select>
        </label>
        <label className={styles.searchField}>
          <span>本文検索</span>
          <input
            defaultValue={query ?? ""}
            maxLength={80}
            name="q"
            placeholder="例: exception / Done"
            type="search"
          />
        </label>
        <button className={styles.filterButton} type="submit">
          絞り込む
        </button>
      </form>

      <StatePanel className={styles.securityNotice} title="ログは二段階でredactされます" variant="info">
        ANSI / Minecraft legacy formatting、IPv4 / IPv6、Bearer Token、password / secret / token系をOCI側とWeb側の両方で除去し、最大行数・文字数・保持時間も制限します。
      </StatePanel>

      {loadError ? (
        <StatePanel className={styles.viewerState} title="Log storageはまだ利用できません" variant="warning">
          Production MigrationとReporter rolloutが完了するまではログを0件と推測せず、既存の監視・Minecraft稼働へ影響しない待機状態として表示します。
        </StatePanel>
      ) : (
        <div className={styles.viewerWrap}>
          <LogViewer
            initialEntries={entries}
            key={viewerKey}
            level={level}
            query={query}
            range={range}
            serverId={DEFAULT_SERVER_ID}
            sourceName={sourceName}
          />
        </div>
      )}
    </PageContent>
  );
}
