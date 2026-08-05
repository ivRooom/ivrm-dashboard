import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  canReadConsoleDuringRollout,
  getConsoleSession,
} from "../lib/console-auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "IVRM Console",
  description: "IVRMのサービスとインフラを監視する統合運用コンソール",
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

export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await getConsoleSession();
  const allowed = canReadConsoleDuringRollout(session);

  return (
    <html lang="ja">
      <body>
        <nav
          aria-label="管理コンソール"
          style={{
            position: "fixed",
            zIndex: 1000,
            top: 12,
            right: 12,
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <a href="/operations" style={navigationLinkStyle}>
            操作基盤
          </a>
          <a href="/security" style={navigationLinkStyle}>
            認証・権限
          </a>
        </nav>
        {allowed ? (
          children
        ) : (
          <main
            style={{
              minHeight: "100vh",
              display: "grid",
              placeItems: "center",
              padding: 24,
              background: "#07111f",
              color: "#e8eef7",
              fontFamily: "system-ui, sans-serif",
            }}
          >
            <section style={{ maxWidth: 620 }}>
              <p style={{ color: "#8ba4c7", letterSpacing: ".12em" }}>
                IVRM CONSOLE
              </p>
              <h1>この管理コンソールを利用できません</h1>
              <p style={{ color: "#b8c7dc", lineHeight: 1.8 }}>
                Cloudflare Accessの認証、利用者登録、またはWebコンソールロールを確認してください。
              </p>
            </section>
          </main>
        )}
      </body>
    </html>
  );
}
