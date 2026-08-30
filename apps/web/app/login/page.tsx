import { redirect } from "next/navigation";
import { PageHeader, StatePanel } from "../../components/console-ui";
import { getConsoleSession } from "../../lib/console-auth";
import {
  getDiscordAuthConfiguration,
  getDiscordAuthMode,
  sanitizeReturnPath,
  type DiscordLoginFailureReason,
} from "../../lib/discord-auth";
import styles from "./login.module.css";

export const dynamic = "force-dynamic";

const errorMessages: Record<DiscordLoginFailureReason | "auth_disabled" | "unauthenticated", string> = {
  oauth_denied: "Discordでの認証がキャンセルされました。",
  oauth_provider_error: "Discord側で認証を完了できませんでした。再試行しても解消しない場合は認証設定を確認してください。",
  oauth_state_invalid: "ログイン要求を確認できませんでした。最初からやり直してください。",
  oauth_code_missing: "Discordから認証コードを受け取れませんでした。",
  oauth_exchange_failed: "Discordとの認証処理に失敗しました。時間を置いて再試行してください。",
  discord_identity_invalid: "Discordのユーザー情報を確認できませんでした。",
  guild_membership_required: "対象のDiscordサーバーへ参加しているユーザーだけが利用できます。",
  membership_screening_pending: "Discordサーバーのメンバーシップ確認を完了してください。",
  required_role_missing: "管理コンソール用のDiscordロールが付与されていません。",
  session_create_failed: "ログインセッションを作成できませんでした。",
  configuration_error: "管理コンソールのDiscord認証設定を確認してください。",
  auth_disabled: "Discord認証はまだ有効化されていません。",
  unauthenticated: "Discordでログインしてください。",
};

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] || null;
  }
  return value || null;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const [session, params] = await Promise.all([
    getConsoleSession(),
    searchParams,
  ]);
  const returnPath = sanitizeReturnPath(firstValue(params.returnTo));
  if (session.status === "authenticated") {
    redirect(returnPath);
  }

  const errorCode = firstValue(params.error);
  const loggedOut = firstValue(params.loggedOut) === "1";
  let mode: "disabled" | "report" | "enforce" = "enforce";
  let configured = false;

  try {
    mode = getDiscordAuthMode();
    configured = mode !== "disabled" && getDiscordAuthConfiguration() !== null;
  } catch {
    configured = false;
  }

  const knownError =
    errorCode && errorCode in errorMessages
      ? errorMessages[errorCode as keyof typeof errorMessages]
      : errorCode
        ? "ログイン処理に失敗しました。"
        : null;
  const loginHref = `/api/auth/discord/start?returnTo=${encodeURIComponent(returnPath)}`;

  return (
    <main className={styles.loginPage}>
      <section className={styles.loginCard} aria-label="IVRM Consoleログイン">
        <div className={styles.brandLockup} aria-label="IVRM Console">
          <span className={styles.brandMark} aria-hidden="true">
            IV
          </span>
          <span>IVRM Console</span>
        </div>

        <PageHeader
          className={styles.loginHeader}
          eyebrow="SECURE ACCESS / DISCORD OAUTH"
          title="Discordでログイン"
          description="ivRooomのDiscordサーバーに参加し、管理コンソール専用ロールを持つメンバーだけが利用できます。"
        />

        {knownError ? (
          <div className={styles.messageStack}>
            <StatePanel title="ログイン状態を確認してください" variant="error">
              {knownError}
            </StatePanel>
          </div>
        ) : null}

        {loggedOut ? (
          <div className={styles.messageStack} role="status">
            <div className={styles.successNotice}>
              <strong>ログアウトしました</strong>
              <span>必要になったら、下のボタンからもう一度ログインできます。</span>
            </div>
          </div>
        ) : null}

        {configured ? (
          <a className={styles.discordButton} href={loginHref}>
            <svg
              aria-hidden="true"
              className={styles.discordIcon}
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M19.5 5.34A17.4 17.4 0 0 0 15.15 4l-.54 1.1a16 16 0 0 0-5.22 0L8.85 4A17.5 17.5 0 0 0 4.5 5.34C1.75 9.44 1 13.43 1.37 17.36a17.7 17.7 0 0 0 5.33 2.69l1.3-1.78a11.5 11.5 0 0 1-2.04-.98l.5-.38a12.4 12.4 0 0 0 11.08 0l.5.38c-.65.38-1.33.7-2.04.98l1.3 1.78a17.7 17.7 0 0 0 5.33-2.69c.45-4.56-.77-8.5-3.13-12.02ZM8.2 14.95c-1.04 0-1.9-.96-1.9-2.14 0-1.18.84-2.14 1.9-2.14 1.06 0 1.92.97 1.9 2.14 0 1.18-.84 2.14-1.9 2.14Zm7.6 0c-1.04 0-1.9-.96-1.9-2.14 0-1.18.84-2.14 1.9-2.14 1.06 0 1.92.97 1.9 2.14 0 1.18-.84 2.14-1.9 2.14Z" />
            </svg>
            Discordで続行
          </a>
        ) : (
          <StatePanel
            className={styles.configWarning}
            title="Discord認証を利用できません"
            variant="warning"
          >
            Discord認証の環境変数が未設定です。現在のモード: {mode}
          </StatePanel>
        )}

        <footer className={styles.securityNotes}>
          <strong>SECURITY</strong>
          <span>DiscordのパスワードはIVRM Consoleへ送信されません。</span>
          <span>
            OAuth Tokenはロール確認後に保存せず、Session CookieはHttpOnlyで保護します。
          </span>
        </footer>
      </section>
    </main>
  );
}
