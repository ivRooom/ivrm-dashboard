import type { Metadata, Viewport } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import {
  canReadConsoleDuringRollout,
  getConsoleSession,
  isPublicConsoleRoute,
} from "../lib/console-auth";
import { MobileNavigationLinks } from "./mobile-navigation";
import { NavigationLinks } from "./navigation-links";
import "./globals.css";
import "./responsive.css";

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

const navigationLinkStyle = {
  border: "1px solid rgba(148, 163, 184, 0.35)",
  borderRadius: 999,
  background: "rgba(7, 17, 31, 0.9)",
  color: "#dbeafe",
  padding: "7px 12px",
  fontSize: 12,
  fontWeight: 700,
  textDecoration: "none",
  backdropFilter: "blur(10px)",
} as const;

const roleLabels = {
  viewer: "閲覧者",
  operator: "運用担当",
  administrator: "管理者",
  owner: "所有者",
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

  return (
    <html lang="ja">
      <body>
        <nav
          aria-label="管理コンソール"
          className="console-toolbar-desktop"
          style={{
            position: "fixed",
            zIndex: 1000,
            top: 12,
            right: 12,
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 8,
            maxWidth: "calc(100vw - 24px)",
          }}
        >
          {session.authProvider === "discord" ? (
            <span
              style={{
                ...navigationLinkStyle,
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontWeight: 600,
              }}
            >
              {session.discordAvatarUrl ? (
                <img
                  src={session.discordAvatarUrl}
                  alt=""
                  width={22}
                  height={22}
                  style={{ borderRadius: 999, objectFit: "cover" }}
                />
              ) : null}
              <span>{session.displayName || session.discordUsername}</span>
              {session.role ? (
                <small style={{ color: "#93c5fd" }}>{roleLabels[session.role]}</small>
              ) : null}
            </span>
          ) : null}
          <NavigationLinks style={navigationLinkStyle} />
          {session.authProvider === "discord" ? (
            <form action="/api/auth/logout" method="post" style={{ margin: 0 }}>
              <button
                type="submit"
                style={{
                  ...navigationLinkStyle,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                ログアウト
              </button>
            </form>
          ) : null}
        </nav>

        <details className="console-mobile-menu">
          <summary>
            <span aria-hidden="true" className="console-mobile-menu-icon">☰</span>
            <span>メニュー</span>
          </summary>
          <div className="console-mobile-menu-panel">
            {session.authProvider === "discord" ? (
              <div className="console-mobile-session">
                {session.discordAvatarUrl ? (
                  <img src={session.discordAvatarUrl} alt="" width={34} height={34} />
                ) : null}
                <div>
                  <strong>{session.displayName || session.discordUsername}</strong>
                  {session.role ? <small>{roleLabels[session.role]}</small> : null}
                </div>
              </div>
            ) : null}
            <nav aria-label="モバイル管理コンソール" className="console-mobile-links">
              <MobileNavigationLinks />
            </nav>
            {session.authProvider === "discord" ? (
              <form action="/api/auth/logout" method="post" className="console-mobile-logout-form">
                <button type="submit" className="console-mobile-logout">ログアウト</button>
              </form>
            ) : null}
          </div>
        </details>

        {children}
      </body>
    </html>
  );
}
