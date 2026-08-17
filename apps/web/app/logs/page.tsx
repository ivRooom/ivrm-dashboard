import { LogViewer } from "../../components/log-viewer";
import {
  CONSOLE_LOG_LEVELS,
  CONSOLE_LOG_SOURCES,
  getConsoleLogSource,
  isConsoleLogLevel,
  type ConsoleLogLevel,
  type ConsoleLogSourceName,
} from "../../lib/console-log-types";
import { getConsoleLogs, type ConsoleLogEntry } from "../../lib/logs";
import styles from "./logs.module.css";

export const dynamic = "force-dynamic";

const DEFAULT_SERVER_ID = "oci-minecraft-01";

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
  const queryValue = firstValue(params.q)?.trim() || null;
  const sourceName: ConsoleLogSourceName | null =
    sourceValue && sourceValue !== "all" && getConsoleLogSource(sourceValue)
      ? (sourceValue as ConsoleLogSourceName)
      : null;
  const level: ConsoleLogLevel | null =
    levelValue && levelValue !== "all" && isConsoleLogLevel(levelValue)
      ? levelValue
      : null;
  const query = queryValue && queryValue.length <= 80 ? queryValue : null;

  let entries: ConsoleLogEntry[] = [];
  let loadError = false;
  try {
    entries = await getConsoleLogs({
      serverId: DEFAULT_SERVER_ID,
      sourceName,
      level,
      query,
      limit: 300,
    });
  } catch (error) {
    loadError = true;
    console.error("Console Logの取得に失敗しました", error);
  }

  const sourceCount = new Set(entries.map((entry) => entry.sourceName)).size;
  const warningOrHigherCount = entries.filter((entry) =>
    ["warning", "error", "critical"].includes(entry.level),
  ).length;
  const latest = entries.at(-1) ?? null;

  return (
    <main className="shell">
      <aside className="sidebar">
        <a className="brand" href="/#top">
          <span>IV</span>
          <strong>IVRM Console</strong>
        </a>
        <nav aria-label="メインナビゲーション">
          <a href="/#top">概要</a>
          <a href="/minecraft">Minecraft</a>
          <a href="/hosts">ホスト</a>
          <a href="/containers">コンテナ</a>
          <a aria-current="page" href="/logs">ログ</a>
          <a href="/events">イベント</a>
          <a href="/history">履歴グラフ</a>
          <a href="/operations">操作基盤</a>
        </nav>
        <div className="agent">
          <i className={loadError ? "error" : entries.length > 0 ? "online" : "stale"} />
          Read-only Logs
          <br />
          <small>{loadError ? "取得エラー" : `${entries.length}行を表示`}</small>
        </div>
      </aside>

      <section className={`content ${styles.logsContent}`}>
        <header>
          <div>
            <p className={styles.eyebrow}>READ-ONLY LOG STREAM</p>
            <h1>ログ</h1>
            <p>OCI上のMinecraft・Velocity・Agentログを、機密情報を除去した短期ストリームとして確認します。</p>
            <span className={styles.readOnlyBadge}>READ ONLY / 24H RETENTION</span>
          </div>
          <div className={styles.headerActions}>
            <a className={styles.secondaryLink} href="/events">
              構造化イベント
            </a>
            <a className={styles.secondaryLink} href="/operations">
              操作基盤
            </a>
          </div>
        </header>

        <section className={styles.summaryGrid} aria-label="Log Viewerサマリー">
          <article>
            <span>表示行</span>
            <strong>{loadError ? "—" : entries.length}</strong>
            <small>初回最大300行 / Follow中最大800行</small>
          </article>
          <article>
            <span>Source</span>
            <strong>{loadError ? "—" : sourceCount}</strong>
            <small>Server-side allowlistのみ</small>
          </article>
          <article>
            <span>Warning+</span>
            <strong>{loadError ? "—" : warningOrHigherCount}</strong>
            <small>warning / error / critical</small>
          </article>
          <article>
            <span>最新</span>
            <strong>{latest ? latest.sourceName : "—"}</strong>
            <small>{latest ? formatDateTime(latest.observedAt) : "Log Report待機中"}</small>
          </article>
        </section>

        <form className={styles.filters} method="get">
          <label>
            Source
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
            Level
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
            本文検索
            <input
              defaultValue={query ?? ""}
              maxLength={80}
              name="q"
              placeholder="例: exception / Done"
              type="search"
            />
          </label>
          <button type="submit">絞り込む</button>
        </form>

        <p className={styles.notice}>
          ANSI装飾は除去し、IP・Bearer Token・password / secret / token系の値はOCI側とWeb側の両方でマスクします。Docker Socket、SSH、RCON、任意ShellをBrowserへ公開しません。
        </p>

        {loadError ? (
          <div className={styles.errorNotice} role="alert">
            Log RPCをまだ利用できません。Migration適用とReporter rolloutまでは、既存の監視・Minecraft稼働へ影響しません。
          </div>
        ) : null}

        <LogViewer
          initialEntries={entries}
          level={level}
          query={query}
          serverId={DEFAULT_SERVER_ID}
          sourceName={sourceName}
        />
      </section>
    </main>
  );
}
