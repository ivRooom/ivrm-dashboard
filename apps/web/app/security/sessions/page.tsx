import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  getConsoleSession,
  hasConsoleRole,
  type ConsoleRole,
} from "../../../lib/console-auth";
import { DISCORD_SESSION_COOKIE } from "../../../lib/discord-auth";
import {
  listDiscordConsoleSessions,
  parseDiscordSessionStatus,
  parseUuid,
  type DiscordSessionAdminRow,
  type DiscordSessionStatus,
} from "../../../lib/discord-security-admin";

export const dynamic = "force-dynamic";

const roleLabels: Record<ConsoleRole, string> = {
  viewer: "閲覧者",
  operator: "運用担当",
  administrator: "管理者",
  owner: "所有者",
};

const statusLabels = {
  active: "有効",
  expired: "期限切れ",
  revoked: "失効済み",
} as const;

const revokeReasonLabels: Record<string, string> = {
  logout: "ログアウト",
  replaced: "再ログインによる置換",
  administrator: "管理者による失効",
  expired: "期限切れ",
};

const outcomeMessages: Record<string, string> = {
  revoked: "Sessionを失効しました。",
  unchanged: "対象Sessionは既に失効または期限切れです。",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] || null : value || null;
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
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Asia/Tokyo",
  }).format(date);
}

function parseCursorDate(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function filterHref(status: DiscordSessionStatus): string {
  return `/security/sessions?status=${status}`;
}

function canRevoke(
  actorRole: ConsoleRole | null,
  target: DiscordSessionAdminRow,
): boolean {
  if (target.status !== "active") {
    return false;
  }
  if (actorRole === "owner") {
    return true;
  }
  return actorRole === "administrator" && target.consoleRole !== "owner";
}

export default async function DiscordSessionsPage({ searchParams }: PageProps) {
  const [session, params, cookieStore] = await Promise.all([
    getConsoleSession(),
    searchParams,
    cookies(),
  ]);

  if (!hasConsoleRole(session, "administrator")) {
    redirect("/security?error=administrator_role_required");
  }

  const actorSessionToken = cookieStore.get(DISCORD_SESSION_COOKIE)?.value || null;
  if (!actorSessionToken) {
    redirect("/login?error=unauthenticated");
  }

  const status = parseDiscordSessionStatus(firstValue(params.status));
  const beforeCreatedAt = parseCursorDate(firstValue(params.beforeCreatedAt));
  const beforeId = parseUuid(firstValue(params.beforeId));
  const cursorValid = (beforeCreatedAt === null) === (beforeId === null);
  const outcome = firstValue(params.outcome);
  let rows: DiscordSessionAdminRow[] = [];
  let loadError = false;

  if (cursorValid) {
    try {
      rows = await listDiscordConsoleSessions({
        actorSessionToken,
        status,
        limit: 50,
        beforeCreatedAt,
        beforeId,
      });
    } catch {
      loadError = true;
    }
  } else {
    loadError = true;
  }

  const last = rows.at(-1) ?? null;
  const nextHref =
    rows.length === 50 && last
      ? `/security/sessions?status=${status}&beforeCreatedAt=${encodeURIComponent(last.createdAt)}&beforeId=${encodeURIComponent(last.sessionId)}`
      : null;

  return (
    <main style={pageStyle}>
      <section style={{ maxWidth: 1240, margin: "0 auto" }}>
        <a href="/security" style={backLinkStyle}>
          ← 認証・権限へ戻る
        </a>
        <header style={{ margin: "28px 0" }}>
          <p style={eyebrowStyle}>SESSION SECURITY</p>
          <h1 style={{ fontSize: "clamp(2rem, 5vw, 3.5rem)", margin: "8px 0" }}>
            Discord Session管理
          </h1>
          <p style={leadStyle}>
            Administrator／Ownerだけが利用できます。Token、Cookie、Session Hash、Discord Role IDは表示しません。
          </p>
        </header>

        {outcome && outcomeMessages[outcome] ? (
          <div role="status" style={successStyle}>
            {outcomeMessages[outcome]}
          </div>
        ) : null}

        <nav aria-label="Session状態" style={filterNavStyle}>
          {(["active", "expired", "revoked", "all"] as const).map((item) => (
            <a
              key={item}
              href={filterHref(item)}
              aria-current={status === item ? "page" : undefined}
              style={{
                ...filterLinkStyle,
                borderColor: status === item ? "#60a5fa" : "rgba(148,163,184,.3)",
                color: status === item ? "#dbeafe" : "#94a3b8",
              }}
            >
              {item === "all" ? "すべて" : statusLabels[item]}
            </a>
          ))}
        </nav>

        {loadError ? (
          <div role="alert" style={errorStyle}>
            Session一覧を取得できませんでした。現在のSessionと権限を確認してください。
          </div>
        ) : null}

        {!loadError && rows.length === 0 ? (
          <section style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>対象Sessionはありません</h2>
            <p style={leadStyle}>選択した状態に一致するDiscord Sessionはありません。</p>
          </section>
        ) : null}

        {rows.length > 0 ? (
          <div style={tableShellStyle}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={headerCellStyle}>ユーザー</th>
                  <th style={headerCellStyle}>ロール</th>
                  <th style={headerCellStyle}>状態</th>
                  <th style={headerCellStyle}>作成／最終利用</th>
                  <th style={headerCellStyle}>期限／失効</th>
                  <th style={headerCellStyle}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const revocable = canRevoke(session.role, row);
                  return (
                    <tr key={row.sessionId}>
                      <td style={cellStyle}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          {row.discordAvatarUrl ? (
                            <img
                              src={row.discordAvatarUrl}
                              alt=""
                              width={36}
                              height={36}
                              style={{ borderRadius: 999, objectFit: "cover" }}
                            />
                          ) : null}
                          <div>
                            <strong style={{ display: "block" }}>
                              {row.discordGlobalName || row.discordUsername}
                              {row.isCurrent ? "（現在）" : ""}
                            </strong>
                            <small style={mutedStyle}>@{row.discordUsername}</small>
                            <small style={{ ...mutedStyle, display: "block" }}>
                              {row.discordUserId}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td style={cellStyle}>{roleLabels[row.consoleRole]}</td>
                      <td style={cellStyle}>
                        <span style={statusBadgeStyle(row.status)}>
                          {statusLabels[row.status]}
                        </span>
                      </td>
                      <td style={cellStyle}>
                        <span style={{ display: "block" }}>{formatDateTime(row.createdAt)}</span>
                        <small style={mutedStyle}>最終 {formatDateTime(row.lastSeenAt)}</small>
                      </td>
                      <td style={cellStyle}>
                        <span style={{ display: "block" }}>{formatDateTime(row.expiresAt)}</span>
                        <small style={mutedStyle}>
                          {row.revokedAt
                            ? `${formatDateTime(row.revokedAt)}・${revokeReasonLabels[row.revokeReason || ""] || "失効"}`
                            : "—"}
                        </small>
                      </td>
                      <td style={cellStyle}>
                        {revocable ? (
                          <form
                            action={`/api/security/discord-sessions/${row.sessionId}/revoke`}
                            method="post"
                            style={{ display: "grid", gap: 8, minWidth: 150 }}
                          >
                            <input
                              name="confirmation"
                              required
                              pattern="REVOKE"
                              placeholder="REVOKE"
                              aria-label="確認文字列REVOKE"
                              autoComplete="off"
                              style={inputStyle}
                            />
                            <button type="submit" style={dangerButtonStyle}>
                              Sessionを失効
                            </button>
                          </form>
                        ) : row.status === "active" && row.consoleRole === "owner" ? (
                          <small style={mutedStyle}>Ownerのみ操作可能</small>
                        ) : (
                          <small style={mutedStyle}>操作なし</small>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {nextHref ? (
          <div style={{ marginTop: 20 }}>
            <a href={nextHref} style={filterLinkStyle}>
              次の50件を表示
            </a>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function statusBadgeStyle(status: "active" | "expired" | "revoked") {
  const colors = {
    active: { color: "#86efac", background: "rgba(22,101,52,.25)" },
    expired: { color: "#fde68a", background: "rgba(113,63,18,.25)" },
    revoked: { color: "#fca5a5", background: "rgba(127,29,29,.25)" },
  }[status];
  return {
    display: "inline-flex",
    borderRadius: 999,
    padding: "5px 9px",
    fontSize: 12,
    fontWeight: 800,
    ...colors,
  } as const;
}

const pageStyle = {
  minHeight: "100vh",
  background: "#07111f",
  color: "#e8eef7",
  padding: "72px 20px 80px",
  fontFamily: "system-ui, sans-serif",
} as const;
const backLinkStyle = { color: "#9cc5ff", textDecoration: "none" } as const;
const eyebrowStyle = { color: "#8ba4c7", letterSpacing: ".12em" } as const;
const leadStyle = { color: "#b8c7dc", lineHeight: 1.8 } as const;
const mutedStyle = { color: "#8294ad", lineHeight: 1.5 } as const;
const cardStyle = {
  border: "1px solid rgba(148,163,184,.22)",
  borderRadius: 18,
  padding: 22,
  background: "rgba(15,27,45,.82)",
} as const;
const filterNavStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  margin: "0 0 20px",
} as const;
const filterLinkStyle = {
  display: "inline-flex",
  border: "1px solid rgba(148,163,184,.3)",
  borderRadius: 999,
  padding: "8px 13px",
  color: "#dbeafe",
  textDecoration: "none",
  background: "rgba(15,27,45,.72)",
  fontWeight: 700,
  fontSize: 13,
} as const;
const successStyle = {
  ...cardStyle,
  borderColor: "rgba(74,222,128,.4)",
  color: "#bbf7d0",
  marginBottom: 18,
} as const;
const errorStyle = {
  ...cardStyle,
  borderColor: "rgba(248,113,113,.5)",
  color: "#fecaca",
  marginBottom: 18,
} as const;
const tableShellStyle = {
  overflowX: "auto",
  border: "1px solid rgba(148,163,184,.22)",
  borderRadius: 18,
  background: "rgba(15,27,45,.82)",
} as const;
const tableStyle = {
  width: "100%",
  minWidth: 1080,
  borderCollapse: "collapse",
} as const;
const headerCellStyle = {
  padding: "14px 16px",
  textAlign: "left",
  color: "#8ba4c7",
  borderBottom: "1px solid rgba(148,163,184,.22)",
  fontSize: 12,
  letterSpacing: ".06em",
} as const;
const cellStyle = {
  padding: "16px",
  verticalAlign: "top",
  borderBottom: "1px solid rgba(148,163,184,.12)",
  fontSize: 14,
} as const;
const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid rgba(248,113,113,.45)",
  borderRadius: 9,
  padding: "8px 10px",
  background: "#07111f",
  color: "#e8eef7",
} as const;
const dangerButtonStyle = {
  border: "1px solid rgba(248,113,113,.55)",
  borderRadius: 9,
  padding: "8px 10px",
  background: "rgba(127,29,29,.34)",
  color: "#fecaca",
  fontWeight: 800,
  cursor: "pointer",
} as const;
