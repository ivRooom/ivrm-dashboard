import { consoleNavigationItems } from "./console-navigation";

export function MobileNavigationLinks() {
  return consoleNavigationItems
    .filter((item) => item.mobile)
    .map((item) => (
      <a key={item.href} href={item.href} className="console-mobile-link">{item.label}</a>
    ));
}
