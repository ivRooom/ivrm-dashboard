"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

type AutoRefreshProps = {
  intervalMs?: number;
};

function hasActiveEditor(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLSelectElement ||
    (active instanceof HTMLElement && active.isContentEditable)
  );
}

export function AutoRefresh({ intervalMs = 15_000 }: AutoRefreshProps) {
  const router = useRouter();

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || hasActiveEditor()) {
        return;
      }
      router.refresh();
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [intervalMs, router]);

  return null;
}
