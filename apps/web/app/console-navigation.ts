export type ConsoleNavigationGroupId =
  | "overview"
  | "minecraft"
  | "infrastructure"
  | "observability"
  | "protection"
  | "administration";

export type ConsoleNavigationGroup = {
  id: ConsoleNavigationGroupId;
  label: string;
};

export type ConsoleRange = "1h" | "6h" | "24h" | "7d" | "30d";

export type ConsoleNavigationItem = {
  href: string;
  label: string;
  group: ConsoleNavigationGroupId;
  description: string;
  supportedRanges?: readonly ConsoleRange[];
};

const INCIDENT_RANGES = ["24h", "7d", "30d"] as const satisfies readonly ConsoleRange[];
const HISTORY_RANGES = ["1h", "6h", "24h", "7d", "30d"] as const satisfies readonly ConsoleRange[];

export const consoleNavigationGroups: readonly ConsoleNavigationGroup[] = [
  { id: "overview", label: "Overview" },
  { id: "minecraft", label: "Minecraft" },
  { id: "infrastructure", label: "Infrastructure" },
  { id: "observability", label: "Observability" },
  { id: "protection", label: "Protection" },
  { id: "administration", label: "Administration" },
] as const;

export const consoleNavigationItems: readonly ConsoleNavigationItem[] = [
  {
    href: "/",
    label: "概要",
    group: "overview",
    description: "システム全体の現在状態",
  },
  {
    href: "/minecraft",
    label: "Minecraft",
    group: "minecraft",
    description: "ゲームサーバーの稼働状態",
  },
  {
    href: "/operations",
    label: "操作基盤",
    group: "minecraft",
    description: "許可済み運用操作の基盤",
  },
  {
    href: "/hosts",
    label: "ホスト",
    group: "infrastructure",
    description: "ホストリソースとAgent",
  },
  {
    href: "/containers",
    label: "コンテナ",
    group: "infrastructure",
    description: "Dockerコンテナ状態",
  },
  {
    href: "/inventory",
    label: "インベントリ",
    group: "infrastructure",
    description: "構成とバージョン情報",
  },
  {
    href: "/capacity",
    label: "キャパシティ",
    group: "infrastructure",
    description: "容量と増加傾向",
    supportedRanges: INCIDENT_RANGES,
  },
  {
    href: "/incidents",
    label: "インシデント",
    group: "observability",
    description: "現在と過去の障害",
    supportedRanges: INCIDENT_RANGES,
  },
  {
    href: "/events",
    label: "イベント",
    group: "observability",
    description: "監視イベントの時系列",
    supportedRanges: HISTORY_RANGES,
  },
  {
    href: "/history",
    label: "履歴グラフ",
    group: "observability",
    description: "メトリクス履歴",
    supportedRanges: HISTORY_RANGES,
  },
  {
    href: "/reliability",
    label: "信頼性",
    group: "observability",
    description: "SLOとReliability",
    supportedRanges: INCIDENT_RANGES,
  },
  {
    href: "/backups",
    label: "バックアップ",
    group: "protection",
    description: "バックアップ状態と履歴",
    supportedRanges: INCIDENT_RANGES,
  },
  {
    href: "/notifications",
    label: "通知",
    group: "protection",
    description: "通知SignalとDelivery",
  },
  {
    href: "/security",
    label: "認証・権限",
    group: "administration",
    description: "Session・RBAC・Audit",
  },
] as const;

export function isConsoleNavigationItemActive(
  pathname: string,
  item: ConsoleNavigationItem,
): boolean {
  if (item.href === "/") {
    return pathname === "/";
  }

  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function getConsoleNavigationHref(
  item: ConsoleNavigationItem,
  currentRange: string | null,
): string {
  if (!currentRange || !item.supportedRanges?.includes(currentRange as ConsoleRange)) {
    return item.href;
  }

  const query = new URLSearchParams({ range: currentRange });
  return `${item.href}?${query.toString()}`;
}

export function getActiveConsoleNavigationItem(
  pathname: string,
): ConsoleNavigationItem | null {
  return (
    consoleNavigationItems.find((item) =>
      isConsoleNavigationItemActive(pathname, item),
    ) ?? null
  );
}

export function getConsoleNavigationGroup(
  groupId: ConsoleNavigationGroupId,
): ConsoleNavigationGroup {
  return (
    consoleNavigationGroups.find((group) => group.id === groupId) ??
    consoleNavigationGroups[0]
  );
}
