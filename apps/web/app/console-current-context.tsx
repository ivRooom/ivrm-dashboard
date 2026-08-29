"use client";

import { usePathname } from "next/navigation";
import {
  getActiveConsoleNavigationItem,
  getConsoleNavigationGroup,
} from "./console-navigation";

export function ConsoleCurrentContext() {
  const pathname = usePathname();
  const activeItem = getActiveConsoleNavigationItem(pathname);

  if (!activeItem) {
    return (
      <div className="console-current-context">
        <span>IVRM Console</span>
        <strong>Console</strong>
      </div>
    );
  }

  const group = getConsoleNavigationGroup(activeItem.group);

  return (
    <div className="console-current-context">
      <span>{group.label}</span>
      <strong>{activeItem.label}</strong>
    </div>
  );
}
