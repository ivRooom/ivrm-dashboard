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
  listDiscordAuthAuditLogs,
  parseAuditResult,
  parseDiscordAuditAction,
  parsePositiveInteger,
  type AuditResult,
  type DiscordAuthAuditAction,
  type DiscordAuthAuditRow,
} from "../../../lib/discord-security-admin";
import styles from "./audit.module.css";

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
  oauth_provider_error: "Discord Providerエラー",
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
  return Number.isFinite(date.getTime()) ? value : null;
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

function resultTone(result: AuditResult): ConsoleTone {
  if (result === "success") return "success";
  if (result === "conflict") return "warning";
  return "danger";
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
    <PageContent className={styles.content}>
      <PageHeader
        actions={<ActionLink href="/security">認証・権限へ戻る</ActionLink>}
        className={styles.pageHeader}
        description="Discordログインの成功・拒否・Logout・管理失効だけを表示します。Token、Cookie、Session Hash、Role ID一覧、IP、Providerの詳細文は表示しません。"
        eyebrow="AUTHENTICATION AUDIT"
        title="Discord認証監査"
      />

      <form className={styles.filterForm} method="get">
        <label>
          操作
          <select name="action" defaultValue={action || ""}>
            <option value="">すべて</option>
            {Object.entries(actionLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          結果
          <select name="result" defaultValue={result || ""}>
            <option value="">すべて</option>
            {Object.entries(resultLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button className={styles.filterButton} type="submit">
          絞り込む
        </button>
        <ActionLink href="/security/audit">クリア</ActionLink>
      </form>

      {loadError ? (
        <StatePanel title="認証監査ログを取得できませんでした" variant="error">
          Filter、Session、権限を確認してください。
        </StatePanel>
      ) : null}

      {!loadError && logs.length === 0 ? (
        <StatePanel title="対象ログはありません">
          選択した条件に一致するDiscord認証監査ログはありません。
        </StatePanel>
      ) : null}

      {logs.length > 0 ? (
        <TableShell className={styles.tableShell} label="Discord認証監査ログ">
          <table>
            <thead>
              <tr>
                <th>日時</th>
                <th>操作</th>
                <th>結果</th>
                <th>対象Discord User</th>
                <th>ロール</th>
                <th>理由</th>
                <th>Provider Error</th>
                <th>Request ID</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.auditId}>
                  <td>{formatDateTime(log.occurredAt)}</td>
                  <td>{actionLabels[log.action]}</td>
                  <td>
                    <StatusBadge tone={resultTone(log.result)}>
                      {resultLabels[log.result]}
                    </StatusBadge>
                  </td>
                  <td>{log.discordUserId || "不明"}</td>
                  <td>
                    {log.consoleRole
                      ? roleLabels[log.consoleRole]
                      : log.actorRole
                        ? roleLabels[log.actorRole]
                        : "—"}
                  </td>
                  <td>{log.reason ? reasonLabels[log.reason] || log.reason : "—"}</td>
                  <td className={styles.mono}>{log.providerError || "—"}</td>
                  <td className={styles.mono}>{log.requestId}</td>
                </tr>
              ))}
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
