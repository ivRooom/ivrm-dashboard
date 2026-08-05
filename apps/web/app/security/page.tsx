import {
  getConsoleSession,
  hasConsoleRole,
  type ConsoleRole,
  type ConsoleSession,
  type ConsoleSessionStatus,
} from "../../lib/console-auth";

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
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Tokyo",
  }).format(date);
}

export default async function SecurityPage() {
  const session = await getConsoleSession();
  const canAdministerSecurity = hasConsoleRole(session, "administrator");

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#07111f",
        color: "#e8eef7",
        padding: "72px 24px 80px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <section style={{ maxWidth: 980, margin: "0 auto" }}>
        <a href="/" style={{ color: "#9cc5ff", textDecoration: "none" }}>
          ← システム概要へ戻る
        </a>
        <header style={{ margin: "28px 0" }}>
          <p style={{ color: "#8ba4c7", letterSpacing: ".12em" }}>
            SECURITY &amp; ACCESS
          </p>
          <h1 style={{ fontSize: "clamp(2rem, 5vw, 3.5rem)", margin: "8px 0" }}>
            認証・権限
          </h1>
          <p style={{ color: "#b8c7dc", lineHeight: 1.8 }}>
            DiscordのGuild・専用ロールと、Minecraft LuckPermsとは独立したWebコンソールロールを確認します。
          </p>
        </header>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            gap: 16,
          }}
        >
          <article style={cardStyle}>
            <span style={labelStyle}>認証元</span>
            <strong style={valueStyle}>{providerLabels[session.authProvider]}</strong>
            <small style={smallStyle}>最終認可はServer側Session照合</small>
          </article>
          <article style={cardStyle}>
            <span style={labelStyle}>Discordモード</span>
            <strong style={valueStyle}>{session.discordMode}</strong>
            <small style={smallStyle}>disabled → report → enforce</small>
          </article>
          <article style={cardStyle}>
            <span style={labelStyle}>認証状態</span>
            <strong style={valueStyle}>{statusLabels[session.status]}</strong>
            <small style={smallStyle}>Access: {session.accessState}</small>
          </article>
          <article style={cardStyle}>
            <span style={labelStyle}>Webロール</span>
            <strong style={valueStyle}>
              {session.role ? roleLabels[session.role] : "未割当"}
            </strong>
            <small style={smallStyle}>LuckPermsとは別管理</small>
          </article>
          <article style={cardStyle}>
            <span style={labelStyle}>Discordユーザー</span>
            <strong style={{ ...valueStyle, fontSize: 17 }}>
              {session.displayName || session.discordUsername || "未確認"}
            </strong>
            <small style={smallStyle}>
              {session.discordUserId ? `ID: ${session.discordUserId}` : "—"}
            </small>
          </article>
          <article style={cardStyle}>
            <span style={labelStyle}>一致ロール</span>
            <strong style={valueStyle}>{session.matchedDiscordRoleIds.length}</strong>
            <small style={smallStyle}>Role ID自体は表示しません</small>
          </article>
          <article style={cardStyle}>
            <span style={labelStyle}>Session期限</span>
            <strong style={{ ...valueStyle, fontSize: 16 }}>
              {formatDateTime(session.sessionExpiresAt)}
            </strong>
            <small style={smallStyle}>期限後は再ログインが必要</small>
          </article>
        </section>

        <section style={{ ...cardStyle, marginTop: 20 }}>
          <h2 style={{ marginTop: 0 }}>{statusLabels[session.status]}</h2>
          <p style={{ color: "#b8c7dc", lineHeight: 1.8 }}>
            {statusMessage(session)}
          </p>
        </section>

        {canAdministerSecurity ? (
          <section style={{ ...cardStyle, marginTop: 20 }}>
            <h2 style={{ marginTop: 0 }}>セキュリティ管理</h2>
            <p style={{ color: "#b8c7dc", lineHeight: 1.8 }}>
              Administrator／Ownerだけが利用できます。Session Token、Cookie、Hash、Discord Role ID一覧は表示しません。
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                gap: 14,
                marginTop: 18,
              }}
            >
              <a href="/security/sessions" style={toolLinkStyle}>
                <strong>Discord Session管理</strong>
                <span style={smallStyle}>有効Sessionの確認・強制失効・期限状態</span>
              </a>
              <a href="/security/audit" style={toolLinkStyle}>
                <strong>Discord認証監査</strong>
                <span style={smallStyle}>ログイン成功・拒否・Logout・管理失効</span>
              </a>
            </div>
          </section>
        ) : null}

        <section style={{ ...cardStyle, marginTop: 20 }}>
          <h2 style={{ marginTop: 0 }}>ロール階層</h2>
          <div style={{ display: "grid", gap: 12 }}>
            {permissions.map((item) => (
              <div
                key={item.role}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(120px, 180px) 1fr auto",
                  gap: 16,
                  alignItems: "center",
                  padding: "12px 0",
                  borderBottom: "1px solid rgba(148,163,184,.16)",
                }}
              >
                <strong>{roleLabels[item.role]}</strong>
                <span style={{ color: "#b8c7dc" }}>{item.description}</span>
                <span style={{ color: hasConsoleRole(session, item.role) ? "#86efac" : "#64748b" }}>
                  {hasConsoleRole(session, item.role) ? "利用可能" : "権限なし"}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section style={{ ...cardStyle, marginTop: 20 }}>
          <h2 style={{ marginTop: 0 }}>Discord認証の安全設計</h2>
          <ul style={{ color: "#b8c7dc", lineHeight: 2 }}>
            <li>対象GuildのMember情報から専用Role IDを確認します。</li>
            <li>Membership Screening未完了ユーザーは拒否します。</li>
            <li>複数のRoleが一致した場合は最上位のWebロールを採用します。</li>
            <li>Discord OAuth TokenはRole確認後に保存せず、失効を試みます。</li>
            <li>Session CookieはSecure・HttpOnly・SameSite=Laxです。</li>
            <li>DBにはSession TokenのSHA-256 Hashだけを保存します。</li>
          </ul>
        </section>
      </section>
    </main>
  );
}

const cardStyle = {
  border: "1px solid rgba(148,163,184,.22)",
  borderRadius: 18,
  padding: 20,
  background: "rgba(15, 27, 45, .82)",
} as const;

const labelStyle = {
  display: "block",
  color: "#8ba4c7",
  fontSize: 12,
  letterSpacing: ".08em",
  marginBottom: 10,
} as const;

const valueStyle = {
  display: "block",
  fontSize: 24,
  overflowWrap: "anywhere",
} as const;

const smallStyle = {
  display: "block",
  color: "#8294ad",
  marginTop: 10,
  lineHeight: 1.5,
} as const;

const toolLinkStyle = {
  display: "grid",
  alignContent: "start",
  minHeight: 96,
  border: "1px solid rgba(96,165,250,.35)",
  borderRadius: 14,
  padding: 16,
  background: "rgba(30,64,175,.14)",
  color: "#dbeafe",
  textDecoration: "none",
} as const;
