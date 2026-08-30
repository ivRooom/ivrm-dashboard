import {
  ActionLink,
  MetricCard,
  MetricGrid,
  PageContent,
  PageHeader,
  SectionHeader,
  StatePanel,
  StatusBadge,
} from "../../components/console-ui";
import {
  getConsoleSession,
  hasConsoleRole,
  type ConsoleRole,
  type ConsoleSession,
  type ConsoleSessionStatus,
} from "../../lib/console-auth";
import styles from "./security.module.css";

export const dynamic = "force-dynamic";

const statusLabels: Record<ConsoleSessionStatus, string> = {
  disabled: "認証未適用",
  unauthenticated: "未認証",
  unregistered: "利用者未登録",
  inactive: "利用停止中",
  identity_mismatch: "Identity不一致",
  authenticated: "認証済み",
  error: "認証状態エラー",
};

const roleLabels: Record<ConsoleRole, string> = {
  viewer: "閲覧者",
  operator: "運用担当",
  administrator: "管理者",
  owner: "所有者",
};

const providerLabels = {
  discord: "Discord OAuth2",
  cloudflare_access: "Cloudflare Access",
  none: "未認証",
} as const;

const permissions = [
  { role: "viewer" as const, description: "監視情報・プレイヤー情報の閲覧" },
  { role: "operator" as const, description: "ホワイトリスト、member付与、安全な再起動" },
  { role: "administrator" as const, description: "moderator付与、BAN、停止、運用管理" },
  { role: "owner" as const, description: "admin・owner付与、復元など最重要操作" },
];

function statusMessage(session: ConsoleSession): string {
  if (session.authProvider === "discord" && session.status === "authenticated") {
    return "Discordサーバーへの参加と専用ロールを確認し、短期Sessionを発行しています。Discord OAuth Tokenは保存していません。";
  }
  switch (session.status) {
    case "disabled":
      return "認証は段階導入前です。Discord認証をreportで検証してからenforceへ切り替えます。";
    case "unauthenticated":
      return "Discordでログインし、管理コンソール専用ロールを保持していることを確認してください。";
    case "unregistered":
      return "Cloudflare Access認証は成功していますが、従来のconsole_usersへ利用者が登録されていません。";
    case "inactive":
      return "利用者は登録されていますが、Webコンソール利用が無効化されています。";
    case "identity_mismatch":
      return "登録済みIdentityと認証情報が一致しません。管理者による確認が必要です。";
    case "authenticated":
      return "認証とWebコンソールRBACの両方を確認できました。";
    case "error":
      return "認証設定またはSessionを確認できませんでした。Secret、Token、Cookie値は表示していません。";
  }
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Tokyo",
  }).format(date);
}

function statusTone(status: ConsoleSessionStatus): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "authenticated") return "success";
  if (status === "error" || status === "identity_mismatch") return "danger";
  if (status === "unregistered" || status === "inactive") return "warning";
  if (status === "disabled") return "info";
  return "neutral";
}

function stateVariant(status: ConsoleSessionStatus): "empty" | "error" | "warning" | "info" {
  if (status === "error" || status === "identity_mismatch") return "error";
  if (status === "unregistered" || status === "inactive") return "warning";
  if (status === "authenticated" || status === "disabled") return "info";
  return "empty";
}

export default async function SecurityPage() {
  const session = await getConsoleSession();
  const canAdministerDiscordSecurity =
    session.authProvider === "discord" && hasConsoleRole(session, "administrator");

  return (
    <PageContent className={styles.content}>
      <PageHeader
        className={styles.pageHeader}
        eyebrow="SECURITY & ACCESS"
        title="認証・権限"
        description="DiscordのGuild・専用ロールと、Minecraft LuckPermsとは独立したWebコンソールロールを確認します。"
        actions={<ActionLink href="/operations">操作基盤を確認</ActionLink>}
      />

      <MetricGrid className={styles.metricGrid} label="認証・権限サマリー">
        <MetricCard
          label="AUTH PROVIDER"
          value={providerLabels[session.authProvider]}
          detail="最終認可はServer側Session照合"
        />
        <MetricCard
          label="DISCORD MODE"
          value={session.discordMode}
          detail="disabled → report → enforce"
        />
        <MetricCard
          label="AUTH STATUS"
          value={statusLabels[session.status]}
          detail={`Access: ${session.accessState}`}
          tone={statusTone(session.status)}
        />
        <MetricCard
          label="WEB ROLE"
          value={session.role ? roleLabels[session.role] : "未割当"}
          detail="LuckPermsとは別管理"
        />
        <MetricCard
          label="DISCORD USER"
          value={session.displayName || session.discordUsername || "未確認"}
          detail={session.discordUserId ? `ID: ${session.discordUserId}` : "—"}
        />
        <MetricCard
          label="MATCHED ROLE"
          value={session.matchedDiscordRoleIds.length}
          detail="Role ID自体は表示しません"
        />
        <MetricCard
          label="SESSION EXPIRES"
          value={formatDateTime(session.sessionExpiresAt)}
          detail="期限後は再ログインが必要"
        />
      </MetricGrid>

      <StatePanel
        title={statusLabels[session.status]}
        variant={stateVariant(session.status)}
      >
        {statusMessage(session)}
      </StatePanel>

      {canAdministerDiscordSecurity ? (
        <section className={styles.panel} aria-label="セキュリティ管理">
          <SectionHeader
            eyebrow="ADMINISTRATION"
            title="セキュリティ管理"
            description="Discord Sessionで認証済みのAdministrator / Ownerだけが利用できます。Session Token、Cookie、Hash、Discord Role ID一覧は表示しません。"
          />
          <div className={styles.toolGrid}>
            <a className={styles.toolLink} href="/security/sessions">
              <strong>Discord Session管理</strong>
              <span>有効Sessionの確認・強制失効・期限状態</span>
            </a>
            <a className={styles.toolLink} href="/security/audit">
              <strong>Discord認証監査</strong>
              <span>ログイン成功・拒否・Logout・管理失効</span>
            </a>
          </div>
        </section>
      ) : null}

      <section className={styles.panel} aria-label="Webコンソールロール階層">
        <SectionHeader
          eyebrow="ROLE HIERARCHY"
          title="ロール階層"
          description="WebコンソールRBACはMinecraft LuckPermsと分離し、現在Sessionに許可された範囲だけを表示します。"
        />
        <div className={styles.roleList}>
          {permissions.map((item) => {
            const available = hasConsoleRole(session, item.role);
            return (
              <div className={styles.roleRow} key={item.role}>
                <strong>{roleLabels[item.role]}</strong>
                <span className={styles.roleDescription}>{item.description}</span>
                <StatusBadge tone={available ? "success" : "neutral"}>
                  {available ? "利用可能" : "権限なし"}
                </StatusBadge>
              </div>
            );
          })}
        </div>
      </section>

      <section className={styles.panel} aria-label="Discord認証の安全設計">
        <SectionHeader
          eyebrow="SECURITY BOUNDARY"
          title="Discord認証の安全設計"
          description="表示を統一しても、OAuth・Session・Guild Role Gateの境界は変更しません。"
        />
        <ul className={styles.safetyList}>
          <li>対象GuildのMember情報から専用Role IDを確認します。</li>
          <li>Membership Screening未完了ユーザーは拒否します。</li>
          <li>複数のRoleが一致した場合は最上位のWebロールを採用します。</li>
          <li>Discord OAuth TokenはRole確認後に保存せず、失効を試みます。</li>
          <li>Session CookieはSecure・HttpOnly・SameSite=Laxです。</li>
          <li>DBにはSession TokenのSHA-256 Hashだけを保存します。</li>
        </ul>
      </section>
    </PageContent>
  );
}
