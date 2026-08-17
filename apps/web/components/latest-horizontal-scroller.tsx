"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import styles from "./metric-line-chart.module.css";

type LatestHorizontalScrollerProps = {
  ariaLabel: string;
  children: ReactNode;
};

const SCROLL_END_TOLERANCE_PX = 8;

function scrollMaximum(element: HTMLDivElement): number {
  return Math.max(0, element.scrollWidth - element.clientWidth);
}

function isAtLatestScrollPosition(element: HTMLDivElement): boolean {
  const maximum = scrollMaximum(element);
  return (
    maximum <= SCROLL_END_TOLERANCE_PX ||
    maximum - element.scrollLeft <= SCROLL_END_TOLERANCE_PX
  );
}

export function LatestHorizontalScroller({
  ariaLabel,
  children,
}: LatestHorizontalScrollerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollHorizontally, setCanScrollHorizontally] = useState(false);
  const [isShowingLatest, setIsShowingLatest] = useState(true);

  const syncScrollState = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const maximum = scrollMaximum(element);
    setCanScrollHorizontally(maximum > SCROLL_END_TOLERANCE_PX);
    setIsShowingLatest(isAtLatestScrollPosition(element));
  }, []);

  const scrollToLatest = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const element = scrollRef.current;
      if (!element) {
        return;
      }

      element.scrollTo({ left: scrollMaximum(element), behavior });
      window.requestAnimationFrame(syncScrollState);
    },
    [syncScrollState],
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      scrollToLatest("auto");
    });
    const observer = new ResizeObserver(syncScrollState);
    observer.observe(element);
    const chart = element.firstElementChild;
    if (chart instanceof Element) {
      observer.observe(chart);
    }

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [scrollToLatest, syncScrollState]);

  return (
    <>
      {canScrollHorizontally ? (
        <div className={styles.scrollToolbar}>
          <span>左右にスクロールできます</span>
          <button
            aria-label={`${ariaLabel}を最新時刻までスクロール`}
            className={styles.latestButton}
            disabled={isShowingLatest}
            onClick={() => {
              const reducedMotion = window.matchMedia(
                "(prefers-reduced-motion: reduce)",
              ).matches;
              scrollToLatest(reducedMotion ? "auto" : "smooth");
            }}
            type="button"
          >
            {isShowingLatest ? "最新を表示中" : "最新へ"}
          </button>
        </div>
      ) : null}

      <div
        aria-label={`${ariaLabel}グラフの横スクロール領域`}
        className={styles.scroll}
        onScroll={syncScrollState}
        ref={scrollRef}
        role="region"
        tabIndex={canScrollHorizontally ? 0 : undefined}
      >
        {children}
      </div>
    </>
  );
}
