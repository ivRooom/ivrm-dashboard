import type { Metadata, Viewport } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import {
  canReadConsoleDuringRollout,
  getConsoleSession,
  isPublicConsoleRoute,
} from "../lib/console-auth";
import { ConsoleCurrentContext } from "./console-current-context";
import { ConsolePageLandmark } from "./console-page-landmark";
import { MobileNavigationLinks } from "./mobile-navigation";
import { NavigationLinks } from "./navigation-links";
import "./design-tokens.css";
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
          <aside className="console-sidebar" aria-label="Console navigation">
            <a className="console-brand" href="/">
              <span>IV</span>
              <div>
                <strong>IVRM Console</strong>
                <small>Operations</small>
              </div>
            </a>
            <NavigationLinks />
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
                <div className="console-user-context">
                  {session.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      alt=""
                      height={28}
                      src={session.avatarUrl}
                      width={28}
                    />
                  ) : null}
                  <div>
                    <strong>{userLabel}</strong>
                    <small>{roleLabel}</small>
                  </div>
                </div>
                {showDiscordReportLogin ? (
                  <a
                    className="console-report-login"
                    href={discordReportLoginHref}
                  >
                    Discord認証
                  </a>
                ) : null}
                <form action="/api/auth/logout" method="post" className="console-logout-form">
                  <button className="console-logout-button" type="submit">
                    Logout
                  </button>
                </form>
              </div>
            </header>

            <header className="console-mobile-header">
              <a className="console-mobile-brand" href="/">
                <span>IV</span>
                <strong>IVRM Console</strong>
              </a>
              <details className="console-mobile-menu">
                <summary>
                  <span aria-hidden="true" className="console-mobile-menu-icon">☰</span>
                  Menu
                </summary>
                <div className="console-mobile-menu-panel">
                  <div className="console-mobile-context">
                    <ConsoleCurrentContext />
                    <span className="console-environment-badge">{environment}</span>
                  </div>
                  <div className="console-mobile-session">
                    {session.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        alt=""
                        height={30}
                        src={session.avatarUrl}
                        width={30}
                      />
                    ) : null}
                    <div>
                      <strong>{userLabel}</strong>
                      <small>{roleLabel}</small>
                    </div>
                  </div>
                  {showDiscordReportLogin ? (
                    <a
                      className="console-report-login console-report-login-mobile"
                      href={discordReportLoginHref}
                    >
                      Discord認証を完了
                    </a>
                  ) : null}
                  <MobileNavigationLinks />
                  <form action="/api/auth/logout" method="post" className="console-mobile-logout-form">
                    <button className="console-mobile-logout" type="submit">
                      Logout
                    </button>
                  </form>
                </div>
              </details>
            </header>

            <ConsolePageLandmark>{children}</ConsolePageLandmark>
          </div>
        </div>
      </body>
    </html>
  );
}
