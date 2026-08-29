import type { Metadata, Viewport } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import {
  canReadConsoleDuringRollout,
  getConsoleSession,
  isPublicConsoleRoute,
} from "../lib/console-auth";
import { ConsoleCurrentContext } from "./console-current-context";
import { MobileNavigationLinks } from "./mobile-navigation";
import { NavigationLinks } from "./navigation-links";
import "./globals.css";
import "./responsive.css";
import "./console-shell.css";

export const metadata: Metadata = {
  title: "IVRM Console",
  description: "IVRMのサービスとインフラを監視する統合運用コンソール",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#090b10",
};

const roleLabels = {
  viewer: "閲覧者",
  operator: "運用担当",
  administrator: "管理者",
  owner: "所有者",
} as const;

const environmentLabels = {
  production: "PRODUCTION",
  preview: "PREVIEW",
  development: "LOCAL",
} as const;

export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const [session, publicRoute] = await Promise.all([
    getConsoleSession(),
    isPublicConsoleRoute(),
  ]);

  if (publicRoute) {
    return (
      <html lang="ja">
        <body>{children}</body>
      </html>
    );
  }

  if (!canReadConsoleDuringRollout(session)) {
    redirect("/login?error=unauthenticated");
  }

  const showDiscordReportLogin =
    session.discordMode === "report" && session.authProvider !== "discord";
  const discordReportLoginHref = "/login?returnTo=%2Fsecurity";
  const environment =
    environmentLabels[
      (process.env.VERCEL_ENV as keyof typeof environmentLabels | undefined) ??
        "development"
    ] ?? "LOCAL";
  const userLabel =
    session.displayName ||
    session.discordUsername ||
    session.email ||
    "Console user";
  const roleLabel = session.role ? roleLabels[session.role] : "権限確認中";

  return (
    <html lang="ja">
      <body>
        <div className="console-shell">
          <aside className="console-sidebar">
            <a className="console-brand" href="/" aria-label="IVRM Console Overview">
              <span aria-hidden="true">IV</span>
              <div>
                <strong>IVRM Console</strong>
                <small>Operations</small>
              </div>
            </a>

            <nav aria-label="管理コンソール">
              <NavigationLinks />
            </nav>

            <div className="console-sidebar-footer">
              <div className="console-environment-status">
                <i aria-hidden="true" />
                <div>
                  <span>Environment</span>
                  <strong>{environment}</strong>
                </div>
              </div>
            </div>
          </aside>

          <div className="console-shell-main">
            <header className="console-context-bar">
              <ConsoleCurrentContext />
              <div className="console-context-actions">
                <span className="console-environment-badge">{environment}</span>

                {session.authProvider !== "none" ? (
                  <div className="console-user-context">
                    {session.discordAvatarUrl ? (
                      <img
                        src={session.discordAvatarUrl}
                        alt=""
                        width={28}
                        height={28}
                      />
                    ) : null}
                    <div>
                      <strong>{userLabel}</strong>
                      <small>{roleLabel}</small>
                    </div>
                  </div>
                ) : null}

                {showDiscordReportLogin ? (
                  <a
                    className="console-report-login"
                    href={discordReportLoginHref}
                    aria-label="Discord認証をテストする"
                  >
                    Discord認証を確認
                  </a>
                ) : null}

                {session.authProvider === "discord" ? (
                  <form action="/api/auth/logout" method="post" className="console-logout-form">
                    <button type="submit" className="console-logout-button">
                      ログアウト
                    </button>
                  </form>
                ) : null}
              </div>
            </header>

            <header className="console-mobile-header">
              <a className="console-mobile-brand" href="/" aria-label="IVRM Console Overview">
                <span aria-hidden="true">IV</span>
                <strong>IVRM Console</strong>
              </a>

              <details className="console-mobile-menu">
                <summary>
                  <span aria-hidden="true" className="console-mobile-menu-icon">☰</span>
                  <span>メニュー</span>
                </summary>
                <div className="console-mobile-menu-panel">
                  <div className="console-mobile-context">
                    <ConsoleCurrentContext />
                    <span className="console-environment-badge">{environment}</span>
                  </div>

                  {session.authProvider !== "none" ? (
                    <div className="console-mobile-session">
                      {session.discordAvatarUrl ? (
                        <img src={session.discordAvatarUrl} alt="" width={34} height={34} />
                      ) : null}
                      <div>
                        <strong>{userLabel}</strong>
                        <small>{roleLabel}</small>
                      </div>
                    </div>
                  ) : null}

                  {showDiscordReportLogin ? (
                    <a
                      className="console-report-login console-report-login-mobile"
                      href={discordReportLoginHref}
                    >
                      Discord認証を確認
                    </a>
                  ) : null}

                  <nav aria-label="モバイル管理コンソール">
                    <MobileNavigationLinks />
                  </nav>

                  {session.authProvider === "discord" ? (
                    <form action="/api/auth/logout" method="post" className="console-mobile-logout-form">
                      <button type="submit" className="console-mobile-logout">
                        ログアウト
                      </button>
                    </form>
                  ) : null}
                </div>
              </details>
            </header>

            <div className="console-page">{children}</div>
          </div>
        </div>
      </body>
    </html>
  );
}
