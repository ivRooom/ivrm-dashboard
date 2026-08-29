"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  consoleNavigationGroups,
  consoleNavigationItems,
  getConsoleNavigationHref,
  isConsoleNavigationItemActive,
} from "./console-navigation";

type Props = {
  variant?: "desktop" | "mobile";
};

export function NavigationLinks({ variant = "desktop" }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentRange = searchParams.get("range");

  return (
    <div
      className={
        variant === "desktop"
          ? "console-navigation-groups"
          : "console-mobile-navigation-groups"
      }
    >
      {consoleNavigationGroups.map((group) => {
        const items = consoleNavigationItems.filter(
          (item) => item.group === group.id,
        );

        return (
          <section className="console-navigation-group" key={group.id}>
            <p className="console-navigation-group-label">{group.label}</p>
            <div className="console-navigation-items">
              {items.map((item) => {
                const active = isConsoleNavigationItemActive(pathname, item);
                const href = getConsoleNavigationHref(item, currentRange);
                return (
                  <a
                    aria-current={active ? "page" : undefined}
                    className={
                      variant === "desktop"
                        ? "console-navigation-link"
                        : "console-mobile-link"
                    }
                    href={href}
                    key={item.href}
                    title={item.description}
                  >
                    <span>{item.label}</span>
                  </a>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
