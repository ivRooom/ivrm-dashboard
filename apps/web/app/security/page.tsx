import {
  getConsoleSession,
  hasConsoleRole,
  type ConsoleRole,
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

const permissions = [
  { role: "viewer" as const, description: "監視情報・プレイヤー情報の閲覧" },
  { role: "operator" as const, description: "ホワイトリスト、member付与、安全な再起動" },
  { role: "administrator" as const, description: "moderator付与、BAN、停止、運用管理" },
  { role: "owner" as const, description: "admin・owner付与、復元など最重要操作" },
];

function statusMessage(status: ConsoleSessionStatus): string {
  switch (status) {
    case "disabled":
      return "現在は段階導入前です。監視画面は従来どおり閲覧できますが、書き込み操作は追加しません。";
    case "unauthenticated":
      return "Cloudflare Access JWTを確認できていません。Access ApplicationとPolicyを確認してください。";
    case "unregistered":
      return "Access認証は成功していますが、console_usersへ利用者が登録されていません。";
    case "inactive":
      return "利用者は登録されていますが、Webコンソール利用が無効化されています。";
    case "identity_mismatch":
      return "Access subjectと登録メールの組み合わせが一致しません。管理者による確認が必要です。";
    case "authenticated":
      return "Cloudflare AccessとWebコンソールRBACの両方を確認できました。";
    case "error":
      return "認証設定または利用者情報を確認できませんでした。SecretやJWTは表示していません。";
  }
}

export default async function SecurityPage() {
  const session = await getConsoleSession();

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#07111f",
        color: "#e8eef7",
        padding: "48px 24px 80px",
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
            Cloudflare Accessの検証結果と、Minecraft LuckPermsとは独立したWebコンソールロールを確認します。
          </p>
        </header>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 16,
          }}
        >
          <article style={cardStyle}>
            <span style={labelStyle}>導入モード</span>
            <strong style={valueStyle}>{session.mode}</strong>
            <small style={smallStyle}>
              disabled → report → enforceの順に切り替えます
            </small>
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
            <small style={smallStyle}>LuckPermsグループとは別管理です</small>
          </article>
          <article style={cardStyle}>
            <span style={labelStyle}>利用者</span>
            <strong style={{ ...valueStyle, fontSize: 17 }}>
              {session.displayName || session.email || "未確認"}
            </strong>
            <small style={smallStyle}>
              {session.displayName && session.email ? session.email : "生JWTは保存・表示しません"}
            </small>
          </article>
        </section>

        <section style={{ ...cardStyle, marginTop: 20 }}>
          <h2 style={{ marginTop: 0 }}>{statusLabels[session.status]}</h2>
          <p style={{ color: "#b8c7dc", lineHeight: 1.8 }}>
            {statusMessage(session.status)}
          </p>
        </section>

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
          <h2 style={{ marginTop: 0 }}>段階的な有効化</h2>
          <ol style={{ color: "#b8c7dc", lineHeight: 2 }}>
            <li>Cloudflare Access Applicationと許可Policyを作成</li>
            <li>Team DomainとApplication AudienceをVercelへ設定</li>
            <li>IVRM_ACCESS_MODEをreportへ変更してJWT検証を確認</li>
            <li>検証済みsubとメールをconsole_usersへ登録</li>
            <li>初期ownerの表示を確認してenforceへ変更</li>
            <li>直接Vercel URLでも未認証アクセスが拒否されることを確認</li>
          </ol>
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
