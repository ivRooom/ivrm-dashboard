"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const LEGACY_PAGE_MAIN_PREFIXES = ["/operations", "/security"] as const;

function hasOwnMainLandmark(pathname: string): boolean {
  return LEGACY_PAGE_MAIN_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function ConsolePageLandmark({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (hasOwnMainLandmark(pathname)) {
    return <div className="console-page">{children}</div>;
  }

  return (
    <main className="console-page" id="main-content">
      {children}
    </main>
  );
}
