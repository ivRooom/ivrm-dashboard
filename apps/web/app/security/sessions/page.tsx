import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ActionLink,
  PageContent,
  PageHeader,
  StatePanel,
  StatusBadge,
  TableShell,
  type ConsoleTone,
} from "../../../components/console-ui";
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
import styles from "./sessions.module.css";

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
  return Number.isFinite(date.getTime()) ? value : null;
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

function statusTone(status: "active" | "expired" | "revoked"): ConsoleTone {
  if (status === "active") return "success";
  if (status === "expired") return "warning";
  return "danger";
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
    <PageContent className={styles.content}>
      <PageHeader
        actions={<ActionLink href="/security">認証・権限へ戻る</ActionLink>}
        className={styles.pageHeader}
        description="Administrator／Ownerだけが利用できます。Token、Cookie、Session Hash、Discord Role IDは表示しません。"
        eyebrow="SESSION SECURITY"
        title="Discord Session管理"
      />

      {outcome && outcomeMessages[outcome] ? (
        <div role="status">
          <StatePanel title={outcomeMessages[outcome]} variant="info" />
        </div>
      ) : null}

      <nav aria-label="Session状態" className={styles.filterNav}>
        {(["active", "expired", "revoked", "all"] as const).map((item) => (
          <a
            aria-current={status === item ? "page" : undefined}
            className={styles.filterLink}
            href={filterHref(item)}
            key={item}
          >
            {item === "all" ? "すべて" : statusLabels[item]}
          </a>
        ))}
      </nav>

      {loadError ? (
        <StatePanel title="Session一覧を取得できませんでした" variant="error">
          現在のSessionと権限を確認してください。
        </StatePanel>
      ) : null}

      {!loadError && rows.length === 0 ? (
        <StatePanel title="対象Sessionはありません">
          選択した状態に一致するDiscord Sessionはありません。
        </StatePanel>
      ) : null}

      {rows.length > 0 ? (
        <TableShell className={styles.tableShell} label="Discord Session一覧">
          <table>
            <thead>
              <tr>
                <th>ユーザー</th>
                <th>ロール</th>
                <th>状態</th>
                <th>作成／最終利用</th>
                <th>期限／失効</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const revocable = canRevoke(session.role, row);
                return (
                  <tr key={row.sessionId}>
                    <td>
                      <div className={styles.userCell}>
                        {row.discordAvatarUrl ? (
                          <img
                            alt=""
                            className={styles.avatar}
                            height={36}
                            src={row.discordAvatarUrl}
                            width={36}
                          />
                        ) : null}
                        <div>
                          <strong className={styles.userName}>
                            {row.discordGlobalName || row.discordUsername}
                            {row.isCurrent ? "（現在）" : ""}
                          </strong>
                          <small className={styles.muted}>@{row.discordUsername}</small>
                          <small className={styles.mutedBlock}>{row.discordUserId}</small>
                        </div>
                      </div>
                    </td>
                    <td>{roleLabels[row.consoleRole]}</td>
                    <td>
                      <StatusBadge tone={statusTone(row.status)}>
                        {statusLabels[row.status]}
                      </StatusBadge>
                    </td>
                    <td>
                      <span className={styles.dateValue}>{formatDateTime(row.createdAt)}</span>
                      <small className={styles.muted}>最終 {formatDateTime(row.lastSeenAt)}</small>
                    </td>
                    <td>
                      <span className={styles.dateValue}>{formatDateTime(row.expiresAt)}</span>
                      <small className={styles.muted}>
                        {row.revokedAt
                          ? `${formatDateTime(row.revokedAt)}・${revokeReasonLabels[row.revokeReason || ""] || "失効"}`
                          : "—"}
                      </small>
                    </td>
                    <td>
                      {revocable ? (
                        <form
                          action={`/api/security/discord-sessions/${row.sessionId}/revoke`}
                          className={styles.revokeForm}
                          method="post"
                        >
                          <input
                            aria-label="確認文字列REVOKE"
                            autoComplete="off"
                            className={styles.revokeInput}
                            name="confirmation"
                            pattern="REVOKE"
                            placeholder="REVOKE"
                            required
                          />
                          <button className={styles.revokeButton} type="submit">
                            Sessionを失効
                          </button>
                        </form>
                      ) : row.status === "active" && row.consoleRole === "owner" ? (
                        <small className={styles.muted}>Ownerのみ操作可能</small>
                      ) : (
                        <small className={styles.muted}>操作なし</small>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableShell>
      ) : null}

      {nextHref ? (
        <div className={styles.pagination}>
          <ActionLink href={nextHref}>次の50件を表示</ActionLink>
        </div>
      ) : null}
    </PageContent>
  );
}
