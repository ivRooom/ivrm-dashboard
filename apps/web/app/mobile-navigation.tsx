const mobileLinks = [
  ["/", "概要"],
  ["/minecraft", "Minecraft"],
  ["/hosts", "ホスト"],
  ["/containers", "コンテナ"],
  ["/incidents", "インシデント"],
  ["/backups", "バックアップ"],
  ["/notifications", "通知"],
  ["/reliability", "信頼性"],
  ["/inventory", "インベントリ"],
  ["/history", "履歴グラフ"],
  ["/events", "イベント"],
  ["/operations", "操作基盤"],
  ["/security", "認証・権限"],
] as const;

export function MobileNavigationLinks() {
  return mobileLinks.map(([href, label]) => (
    <a key={href} href={href} className="console-mobile-link">{label}</a>
  ));
}
