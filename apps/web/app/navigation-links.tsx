type Props = {
  style: Readonly<Record<string, string | number>>;
};

const links = [
  ["/hosts", "ホスト"],
  ["/containers", "コンテナ"],
  ["/incidents", "インシデント"],
  ["/backups", "バックアップ"],
  ["/notifications", "通知"],
  ["/reliability", "信頼性"],
  ["/events", "イベント"],
  ["/operations", "操作基盤"],
  ["/security", "認証・権限"],
] as const;

export function NavigationLinks({ style }: Props) {
  return links.map(([href, label]) => (
    <a key={href} href={href} style={style}>{label}</a>
  ));
}
