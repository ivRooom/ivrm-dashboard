import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  getConsoleSession,
  hasConsoleRole,
  type ConsoleRole,
} from "../../../lib/console-auth";
import { DISCORD_SESSION_COOKIE } from "../../../lib/discord-auth";
import {
  listDiscordAuthAuditLogs,
  parseAuditResult,
  parseDiscordAuditAction,
  parsePositiveInteger,
  type AuditResult,
  type DiscordAuthAuditAction,
  type DiscordAuthAuditRow,
} from "../../../lib/discord-security-admin";

export const dynamic = "force-dynamic";

const actionLabels: Record<DiscordAuthAuditAction, string> = {
  DISCORD_LOGIN_SUCCEEDED: "ログイン成功",
  DISCORD_LOGIN_DENIED: "ログイン拒否",
  DISCORD_SESSION_REVOKED: "ログアウト／Session失効",
  DISCORD_SESSION_ADMIN_REVOKED: "管理者によるSession失効",
};

const resultLabels: Record<AuditResult, string> = {
  success: "成功",
  denied: "拒否",
  conflict: "競合",
  error: "エラー",
};

const roleLabels: Record<ConsoleRole, string> = {
  viewer: "閲覧者",
  operator: "運用担当",
  administrator: "管理者",
  owner: "所有者",
};

const reasonLabels: Record<string, string> = {
  oauth_denied: "OAuthキャンセル",
  oauth_state_invalid: "state不一致",
  oauth_code_missing: "認証コードなし",
  oauth_exchange_failed: "Token交換失敗",
  discord_identity_invalid: "Discord Identity取得失敗",
  guild_membership_required: "Guild未参加",
  membership_screening_pending: "Membership Screening未完了",
  required_role_missing: "専用ロールなし",
  session_create_failed: "Session作成失敗",
  configuration_error: "認証設定エラー",
  logout: "ログアウト",
  administrator: "管理者による失効",
  owner_session_protected: "Owner Session保護",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function parseCursorDate(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function formatDateTime(value: string): string {
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

function buildNextHref(
  action: DiscordAuthAuditAction | null,
  result: AuditResult | null,
  last: DiscordAuthAuditRow,
): string {
  const query = new URLSearchParams();
  if (action) query.set("action", action);
  if (result) query.set("result", result);
  query.set("beforeOccurredAt", last.occurredAt);
  query.set("beforeId", String(last.auditId));
  return `/security/audit?${query.toString()}`;
}

export default async function DiscordAuthAuditPage({ searchParams }: PageProps) {
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

  const actionRaw = firstValue(params.action);
  const resultRaw = firstValue(params.result);
  const action = actionRaw ? parseDiscordAuditAction(actionRaw) : null;
  const result = resultRaw ? parseAuditResult(resultRaw) : null;
  const beforeOccurredAt = parseCursorDate(firstValue(params.beforeOccurredAt));
  const beforeId = parsePositiveInteger(firstValue(params.beforeId));
  const filtersValid = (!actionRaw || action !== null) && (!resultRaw || result !== null);
  const cursorValid = (beforeOccurredAt === null) === (beforeId === null);

  let logs: DiscordAuthAuditRow[] = [];
  let loadError = false;
  if (filtersValid && cursorValid) {
    try {
      logs = await listDiscordAuthAuditLogs({
        actorSessionToken,
        action,
        result,
        limit: 50,
        beforeOccurredAt,
        beforeId,
      });
    } catch {
      loadError = true;
    }
  } else {
    loadError = true;
  }

  const last = logs.at(-1) ?? null;
  const nextHref = logs.length === 50 && last ? buildNextHref(action, result, last) : null;

  return (
    <main style={pageStyle}>
      <section style={{ maxWidth: 1240, margin: "0 auto" }}>
        <a href="/security" style={backLinkStyle}>
          ← 認証・権限へ戻る
        </a>
        <header style={{ margin: "28px 0" }}>
          <p style={eyebrowStyle}>AUTHENTICATION AUDIT</p>
          <h1 style={{ fontSize: "clamp(2rem, 5vw, 3.5rem)", margin: "8px 0" }}>
            Discord認証監査
          </h1>
          <p style={leadStyle}>
            Discordログインの成功・拒否・Logout・管理失効だけを表示します。Token、Cookie、Session Hash、Role ID一覧、IPは表示しません。
          </p>
        </header>

        <form method="get" style={filterFormStyle}>
          <label style={labelStyle}>
            操作
            <select name="action" defaultValue={action || ""} style={selectStyle}>
              <option value="">すべて</option>
              {Object.entries(actionLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            結果
            <select name="result" defaultValue={result || ""} style={selectStyle}>
              <option value="">すべて</option>
              {Object.entries(resultLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" style={buttonStyle}>
            絞り込む
          </button>
          <a href="/security/audit" style={clearLinkStyle}>
            クリア
          </a>
        </form>

        {loadError ? (
          <div role="alert" style={errorStyle}>
            認証監査ログを取得できませんでした。Filter、Session、権限を確認してください。
          </div>
        ) : null}

        {!loadError && logs.length === 0 ? (
          <section style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>対象ログはありません</h2>
            <p style={leadStyle}>選択した条件に一致するDiscord認証監査ログはありません。</p>
          </section>
        ) : null}

        {logs.length > 0 ? (
          <div style={tableShellStyle}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={headerCellStyle}>日時</th>
                  <th style={headerCellStyle}>操作</th>
                  <th style={headerCellStyle}>結果</th>
                  <th style={headerCellStyle}>対象Discord User</th>
                  <th style={headerCellStyle}>ロール</th>
                  <th style={headerCellStyle}>理由</th>
                  <th style={headerCellStyle}>Request ID</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.auditId}>
                    <td style={cellStyle}>{formatDateTime(log.occurredAt)}</td>
                    <td style={cellStyle}>{actionLabels[log.action]}</td>
                    <td style={cellStyle}>
                      <span style={resultBadgeStyle(log.result)}>
                        {resultLabels[log.result]}
                      </span>
                    </td>
                    <td style={cellStyle}>{log.discordUserId || "不明"}</td>
                    <td style={cellStyle}>
                      {log.consoleRole
                        ? roleLabels[log.consoleRole]
                        : log.actorRole
                          ? roleLabels[log.actorRole]
                          : "—"}
                    </td>
                    <td style={cellStyle}>
                      {log.reason ? reasonLabels[log.reason] || log.reason : "—"}
                    </td>
                    <td style={{ ...cellStyle, fontFamily: "ui-monospace, monospace" }}>
                      {log.requestId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {nextHref ? (
          <div style={{ marginTop: 20 }}>
            <a href={nextHref} style={clearLinkStyle}>
              次の50件を表示
            </a>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function resultBadgeStyle(result: AuditResult) {
  const colors = {
    success: { color: "#86efac", background: "rgba(22,101,52,.25)" },
    denied: { color: "#fca5a5", background: "rgba(127,29,29,.25)" },
    conflict: { color: "#fde68a", background: "rgba(113,63,18,.25)" },
    error: { color: "#fda4af", background: "rgba(136,19,55,.25)" },
  }[result];
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
const cardStyle = {
  border: "1px solid rgba(148,163,184,.22)",
  borderRadius: 18,
  padding: 22,
  background: "rgba(15,27,45,.82)",
} as const;
const filterFormStyle = {
  ...cardStyle,
  display: "flex",
  flexWrap: "wrap",
  gap: 14,
  alignItems: "end",
  marginBottom: 20,
} as const;
const labelStyle = {
  display: "grid",
  gap: 7,
  color: "#b8c7dc",
  fontSize: 13,
} as const;
const selectStyle = {
  minWidth: 210,
  border: "1px solid rgba(148,163,184,.35)",
  borderRadius: 10,
  padding: "9px 11px",
  background: "#07111f",
  color: "#e8eef7",
} as const;
const buttonStyle = {
  border: "1px solid rgba(96,165,250,.5)",
  borderRadius: 10,
  padding: "10px 14px",
  background: "rgba(30,64,175,.28)",
  color: "#dbeafe",
  fontWeight: 800,
  cursor: "pointer",
} as const;
const clearLinkStyle = {
  display: "inline-flex",
  border: "1px solid rgba(148,163,184,.3)",
  borderRadius: 10,
  padding: "9px 13px",
  color: "#dbeafe",
  textDecoration: "none",
  background: "rgba(15,27,45,.72)",
  fontWeight: 700,
  fontSize: 13,
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
