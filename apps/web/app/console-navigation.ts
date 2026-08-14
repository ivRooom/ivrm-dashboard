export type ConsoleNavigationItem = {
  href: string;
  label: string;
  desktop: boolean;
  mobile: boolean;
};

export const consoleNavigationItems: readonly ConsoleNavigationItem[] = [
  { href: "/", label: "概要", desktop: false, mobile: true },
  { href: "/minecraft", label: "Minecraft", desktop: false, mobile: true },
  { href: "/hosts", label: "ホスト", desktop: true, mobile: true },
  { href: "/containers", label: "コンテナ", desktop: true, mobile: true },
  { href: "/incidents", label: "インシデント", desktop: true, mobile: true },
  { href: "/backups", label: "バックアップ", desktop: true, mobile: true },
  { href: "/notifications", label: "通知", desktop: true, mobile: true },
  { href: "/reliability", label: "信頼性", desktop: true, mobile: true },
  { href: "/inventory", label: "インベントリ", desktop: true, mobile: true },
  { href: "/capacity", label: "キャパシティ", desktop: true, mobile: true },
  { href: "/history", label: "履歴グラフ", desktop: false, mobile: true },
  { href: "/events", label: "イベント", desktop: true, mobile: true },
  { href: "/operations", label: "操作基盤", desktop: true, mobile: true },
  { href: "/security", label: "認証・権限", desktop: true, mobile: true },
] as const;
