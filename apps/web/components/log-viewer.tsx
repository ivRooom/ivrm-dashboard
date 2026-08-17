"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getConsoleLogRangeMinutes,
  type ConsoleLogLevel,
  type ConsoleLogRange,
  type ConsoleLogSourceName,
} from "../lib/console-log-types";
import type { ConsoleLogEntry } from "../lib/logs";
import styles from "./log-viewer.module.css";

const POLL_INTERVAL_MS = 5_000;
const MAX_RENDERED_ENTRIES = 800;
const BOTTOM_TOLERANCE_PX = 72;

type LogViewerProps = {
  initialEntries: ConsoleLogEntry[];
  serverId: string;
  sourceName: ConsoleLogSourceName | null;
  level: ConsoleLogLevel | null;
  range: ConsoleLogRange;
  query: string | null;
};

type PollResponse = {
  entries: ConsoleLogEntry[];
  lastId: number;
  polledAt: string;
};

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}

function isNearBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_TOLERANCE_PX;
}

function mergeEntries(
  current: ConsoleLogEntry[],
  incoming: ConsoleLogEntry[],
  range: ConsoleLogRange,
  referenceTime: string,
): ConsoleLogEntry[] {
  const referenceMs = Date.parse(referenceTime);
  const cutoffMs = referenceMs - getConsoleLogRangeMinutes(range) * 60_000;
  const byId = new Map<number, ConsoleLogEntry>();
  for (const entry of current) {
    if (Date.parse(entry.observedAt) >= cutoffMs) byId.set(entry.id, entry);
  }
  for (const entry of incoming) {
    if (Date.parse(entry.observedAt) >= cutoffMs) byId.set(entry.id, entry);
  }
  return [...byId.values()]
    .sort((left, right) => left.id - right.id)
    .slice(-MAX_RENDERED_ENTRIES);
}

export function LogViewer({
  initialEntries,
  serverId,
  sourceName,
  level,
  range,
  query,
}: LogViewerProps) {
  const [entries, setEntries] = useState(initialEntries.slice(-MAX_RENDERED_ENTRIES));
  const [follow, setFollow] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const [pollError, setPollError] = useState(false);
  const [lastPollAt, setLastPollAt] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef(initialEntries.at(-1)?.id ?? 0);
  const shouldStickRef = useRef(true);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    shouldStickRef.current = true;
    window.requestAnimationFrame(() => setAtBottom(true));
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => scrollToLatest("auto"));
    return () => window.cancelAnimationFrame(frame);
  }, [scrollToLatest]);

  useEffect(() => {
    if (!follow) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const schedule = () => {
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    const poll = async () => {
      controller = new AbortController();
      try {
        const params = new URLSearchParams({
          server: serverId,
          after: String(lastIdRef.current),
          limit: "200",
          range,
        });
        if (sourceName) params.set("source", sourceName);
        if (level) params.set("level", level);
        if (query) params.set("q", query);

        const response = await fetch(`/api/logs?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error("log_poll_failed");
        const payload = (await response.json()) as PollResponse;
        if (
          !Array.isArray(payload.entries) ||
          !Number.isSafeInteger(payload.lastId) ||
          typeof payload.polledAt !== "string" ||
          !Number.isFinite(Date.parse(payload.polledAt))
        ) {
          throw new Error("invalid_log_poll_response");
        }

        lastIdRef.current = Math.max(lastIdRef.current, payload.lastId);
        setEntries((current) => mergeEntries(current, payload.entries, range, payload.polledAt));
        if (payload.entries.length > 0 && autoScroll && shouldStickRef.current) {
          window.requestAnimationFrame(() => scrollToLatest("auto"));
        }
        setLastPollAt(payload.polledAt);
        setPollError(false);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setPollError(true);
        }
      } finally {
        controller = null;
        schedule();
      }
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [autoScroll, follow, level, query, range, scrollToLatest, serverId, sourceName]);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nearBottom = isNearBottom(viewport);
    shouldStickRef.current = nearBottom;
    setAtBottom(nearBottom);
  }, []);

  const handleAutoScrollToggle = useCallback(() => {
    if (autoScroll && atBottom) {
      setAutoScroll(false);
      return;
    }

    setAutoScroll(true);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.requestAnimationFrame(() => scrollToLatest(reducedMotion ? "auto" : "smooth"));
  }, [atBottom, autoScroll, scrollToLatest]);

  const autoScrollStatus = autoScroll
    ? atBottom
      ? "Auto-scroll ON"
      : "Auto-scroll PAUSED"
    : "Auto-scroll OFF";
  const autoScrollAction = !autoScroll
    ? "自動スクロール開始"
    : atBottom
      ? "自動スクロール停止"
      : "自動スクロール再開";

  return (
    <section className={styles.viewer} aria-label="Console Log Viewer">
      <div className={styles.toolbar}>
        <div>
          <strong>{follow ? "Follow ON" : "Follow OFF"} / {autoScrollStatus}</strong>
          <span aria-live="polite">
            {pollError
              ? "最新ログの確認に失敗しました。次の周期で再試行します。"
              : lastPollAt
                ? `最終確認 ${formatTimestamp(lastPollAt)}`
                : "5秒ごとに新着を確認します。"}
          </span>
        </div>
        <div className={styles.actions}>
          {!atBottom ? (
            <button
              onClick={() => {
                const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                scrollToLatest(reducedMotion ? "auto" : "smooth");
              }}
              type="button"
            >
              最新へ
            </button>
          ) : null}
          <button
            aria-pressed={autoScroll && atBottom}
            className={autoScroll ? styles.followActive : undefined}
            onClick={handleAutoScrollToggle}
            type="button"
          >
            {autoScrollAction}
          </button>
          <button
            aria-pressed={follow}
            className={follow ? styles.followActive : undefined}
            onClick={() => setFollow((current) => !current)}
            type="button"
          >
            {follow ? "Follow停止" : "Follow開始"}
          </button>
        </div>
      </div>

      <div
        aria-label="ログ出力"
        aria-live="off"
        className={styles.viewport}
        onScroll={handleScroll}
        ref={viewportRef}
        role="log"
        tabIndex={0}
      >
        {entries.length === 0 ? (
          <div className={styles.empty}>
            <strong>表示できるログはまだありません</strong>
            <span>Reporterが有効になると、選択期間内のredact済みログだけがここへ表示されます。</span>
          </div>
        ) : (
          <ol className={styles.lines}>
            {entries.map((entry) => (
              <li className={styles.line} key={entry.id}>
                <time dateTime={entry.observedAt}>{formatTimestamp(entry.observedAt)}</time>
                <span className={styles.source}>{entry.sourceName}</span>
                <span className={`${styles.level} ${styles[`level${entry.level}`]}`}>{entry.level}</span>
                <code>{entry.message}</code>
              </li>
            ))}
          </ol>
        )}
      </div>

      <footer className={styles.footer}>
        <span>最大表示 {MAX_RENDERED_ENTRIES}行</span>
        <span>Followと自動スクロールは独立して制御できます</span>
        <span>保存対象はredact済み・24時間以内のみ</span>
      </footer>
    </section>
  );
}
