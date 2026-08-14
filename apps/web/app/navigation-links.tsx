import { consoleNavigationItems } from "./console-navigation";

type Props = {
  style: Readonly<Record<string, string | number>>;
};

export function NavigationLinks({ style }: Props) {
  return consoleNavigationItems
    .filter((item) => item.desktop)
    .map((item) => (
      <a key={item.href} href={item.href} style={style}>{item.label}</a>
    ));
}
