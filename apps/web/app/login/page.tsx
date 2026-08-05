import { redirect } from "next/navigation";
import { getConsoleSession } from "../../lib/console-auth";
import {
  getDiscordAuthConfiguration,
  getDiscordAuthMode,
  type DiscordLoginFailureReason,
} from "../../lib/discord-auth";

export const dynamic = "force-dynamic";

const errorMessages: Record<DiscordLoginFailureReason | "auth_disabled", string> = {
  oauth_denied: "Discordでの認証がキャンセルされました。",
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
  const session = await getConsoleSession();
  if (session.status === "authenticated") {
    redirect("/");
  }

  const params = await searchParams;
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

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background:
          "radial-gradient(circle at top, rgba(88, 101, 242, .24), transparent 38%), #07111f",
        color: "#e8eef7",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <section
        style={{
          width: "min(100%, 520px)",
          border: "1px solid rgba(148, 163, 184, .28)",
          borderRadius: 24,
          padding: "clamp(24px, 6vw, 42px)",
          background: "rgba(15, 27, 45, .92)",
          boxShadow: "0 24px 80px rgba(0, 0, 0, .32)",
          backdropFilter: "blur(18px)",
        }}
      >
        <p style={{ color: "#8ba4c7", letterSpacing: ".14em", marginTop: 0 }}>
          IVRM CONSOLE
        </p>
        <h1 style={{ fontSize: "clamp(2rem, 8vw, 3.2rem)", margin: "8px 0 16px" }}>
          Discordでログイン
        </h1>
        <p style={{ color: "#b8c7dc", lineHeight: 1.8 }}>
          ivRooomのDiscordサーバーに参加し、管理コンソール専用ロールを持つメンバーだけが利用できます。
        </p>

        {knownError ? (
          <div
            role="alert"
            style={{
              border: "1px solid rgba(248, 113, 113, .5)",
              borderRadius: 14,
              padding: 14,
              margin: "20px 0",
              color: "#fecaca",
              background: "rgba(127, 29, 29, .22)",
              lineHeight: 1.7,
            }}
          >
            {knownError}
          </div>
        ) : null}

        {loggedOut ? (
          <div
            role="status"
            style={{
              border: "1px solid rgba(74, 222, 128, .4)",
              borderRadius: 14,
              padding: 14,
              margin: "20px 0",
              color: "#bbf7d0",
              background: "rgba(20, 83, 45, .2)",
            }}
          >
            ログアウトしました。
          </div>
        ) : null}

        {configured ? (
          <a
            href="/api/auth/discord/start?returnTo=/"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              width: "100%",
              boxSizing: "border-box",
              marginTop: 26,
              borderRadius: 14,
              padding: "14px 18px",
              background: "#5865f2",
              color: "white",
              fontWeight: 800,
              textDecoration: "none",
              boxShadow: "0 12px 30px rgba(88, 101, 242, .3)",
            }}
          >
            <svg
              aria-hidden="true"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M19.5 5.34A17.4 17.4 0 0 0 15.15 4l-.54 1.1a16 16 0 0 0-5.22 0L8.85 4A17.5 17.5 0 0 0 4.5 5.34C1.75 9.44 1 13.43 1.37 17.36a17.7 17.7 0 0 0 5.33 2.69l1.3-1.78a11.5 11.5 0 0 1-2.04-.98l.5-.38a12.4 12.4 0 0 0 11.08 0l.5.38c-.65.38-1.33.7-2.04.98l1.3 1.78a17.7 17.7 0 0 0 5.33-2.69c.45-4.56-.77-8.5-3.13-12.02ZM8.2 14.95c-1.04 0-1.9-.96-1.9-2.14 0-1.18.84-2.14 1.9-2.14 1.06 0 1.92.97 1.9 2.14 0 1.18-.84 2.14-1.9 2.14Zm7.6 0c-1.04 0-1.9-.96-1.9-2.14 0-1.18.84-2.14 1.9-2.14 1.06 0 1.92.97 1.9 2.14 0 1.18-.84 2.14-1.9 2.14Z" />
            </svg>
            Discordで続行
          </a>
        ) : (
          <div
            style={{
              marginTop: 26,
              border: "1px solid rgba(250, 204, 21, .4)",
              borderRadius: 14,
              padding: 16,
              color: "#fef08a",
              background: "rgba(113, 63, 18, .2)",
              lineHeight: 1.7,
            }}
          >
            Discord認証の環境変数が未設定です。現在のモード: {mode}
          </div>
        )}

        <div
          style={{
            display: "grid",
            gap: 10,
            marginTop: 28,
            paddingTop: 22,
            borderTop: "1px solid rgba(148, 163, 184, .18)",
            color: "#8294ad",
            fontSize: 13,
            lineHeight: 1.7,
          }}
        >
          <span>DiscordのパスワードはIVRM Consoleへ送信されません。</span>
          <span>OAuth Tokenはロール確認後に保存せず、Session CookieはHttpOnlyで保護します。</span>
        </div>
      </section>
    </main>
  );
}
