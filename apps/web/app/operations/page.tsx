import {
  getConsoleSession,
  type ConsoleRole,
} from "../../lib/console-auth";
import {
  getOperationCapabilities,
  type OperationRisk,
} from "../../lib/operation-catalog";

export const dynamic = "force-dynamic";

const roleLabels: Record<ConsoleRole, string> = {
  viewer: "閲覧者",
  operator: "運用担当",
  administrator: "管理者",
  owner: "所有者",
};

const riskLabels: Record<OperationRisk, string> = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "最重要",
};

const riskColors: Record<OperationRisk, string> = {
  low: "#86efac",
  medium: "#fde68a",
  high: "#fdba74",
  critical: "#fca5a5",
};

const lockLabels = {
  world: "ワールド保存",
  exclusive: "Minecraft排他操作",
  maintenance: "メンテナンス状態",
} as const;

export default async function OperationsPage() {
  const session = await getConsoleSession();
  const capabilities = getOperationCapabilities(session);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#07111f",
        color: "#e8eef7",
        padding: "48px 24px 80px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <section style={{ maxWidth: 1100, margin: "0 auto" }}>
        <a href="/" style={{ color: "#9cc5ff", textDecoration: "none" }}>
          ← システム概要へ戻る
        </a>

        <header style={{ margin: "28px 0" }}>
          <p style={{ color: "#8ba4c7", letterSpacing: ".12em" }}>
            SAFE OPERATIONS FOUNDATION
          </p>
          <h1 style={{ fontSize: "clamp(2rem, 5vw, 3.5rem)", margin: "8px 0" }}>
            操作基盤
          </h1>
          <p style={{ color: "#b8c7dc", lineHeight: 1.8, maxWidth: 820 }}>
            許可済み操作、必要ロール、二段階確認、冪等性、排他制御の設計を確認します。
            現在は読み取り専用で、OCI上のDocker・RCON・Shell操作は実行しません。
          </p>
        </header>

        <section
          style={{
            border: "1px solid rgba(96,165,250,.45)",
            borderRadius: 18,
            padding: 20,
            background: "rgba(30, 64, 175, .12)",
            marginBottom: 20,
          }}
        >
          <strong style={{ display: "block", fontSize: 20 }}>
            実行機能は未接続です
          </strong>
          <p style={{ color: "#bfdbfe", lineHeight: 1.8, marginBottom: 0 }}>
            Job Queueと監査基盤のみを準備しています。専用Minecraft管理Agentが完成するまで、
            ボタンや変更APIは有効化しません。
          </p>
        </section>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 16,
            marginBottom: 20,
          }}
        >
          <article style={cardStyle}>
            <span style={labelStyle}>認証モード</span>
            <strong style={valueStyle}>{session.mode}</strong>
          </article>
          <article style={cardStyle}>
            <span style={labelStyle}>Webロール</span>
            <strong style={valueStyle}>
              {session.role ? roleLabels[session.role] : "未割当"}
            </strong>
          </article>
          <article style={cardStyle}>
            <span style={labelStyle}>許可済み操作</span>
            <strong style={valueStyle}>
              {capabilities.filter((capability) => capability.allowed).length} / {capabilities.length}
            </strong>
          </article>
          <article style={cardStyle}>
            <span style={labelStyle}>実行状態</span>
            <strong style={valueStyle}>無効</strong>
          </article>
        </section>

        <section style={{ display: "grid", gap: 16 }}>
          {capabilities.map((capability) => {
            const availability =
              session.status === "authenticated"
                ? capability.allowed
                  ? "権限あり"
                  : "権限なし"
                : "認証有効化後に判定";

            return (
              <article
                key={capability.type}
                style={{
                  ...cardStyle,
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                  gap: 20,
                  alignItems: "start",
                }}
              >
                <div>
                  <p style={{ ...labelStyle, marginTop: 0 }}>{capability.type}</p>
                  <h2 style={{ margin: "0 0 10px", fontSize: 22 }}>
                    {capability.label}
                  </h2>
                  <span
                    style={{
                      display: "inline-block",
                      border: `1px solid ${riskColors[capability.risk]}55`,
                      borderRadius: 999,
                      padding: "4px 9px",
                      color: riskColors[capability.risk],
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    危険度 {riskLabels[capability.risk]}
                  </span>
                </div>

                <div>
                  <p style={{ color: "#b8c7dc", lineHeight: 1.8, marginTop: 0 }}>
                    {capability.description}
                  </p>
                  <dl
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(110px, 150px) 1fr",
                      gap: "8px 16px",
                      margin: 0,
                    }}
                  >
                    <dt style={termStyle}>必要ロール</dt>
                    <dd style={descriptionStyle}>{roleLabels[capability.requiredRole]}</dd>
                    <dt style={termStyle}>二段階確認</dt>
                    <dd style={descriptionStyle}>
                      {capability.requiresConfirmation ? "確認文字列が必要" : "不要"}
                    </dd>
                    <dt style={termStyle}>排他区分</dt>
                    <dd style={descriptionStyle}>{lockLabels[capability.lockCategory]}</dd>
                    <dt style={termStyle}>現在の判定</dt>
                    <dd
                      style={{
                        ...descriptionStyle,
                        color: capability.allowed ? "#86efac" : "#94a3b8",
                      }}
                    >
                      {availability}
                    </dd>
                  </dl>
                </div>
              </article>
            );
          })}
        </section>

        <section style={{ ...cardStyle, marginTop: 20 }}>
          <h2 style={{ marginTop: 0 }}>安全設計</h2>
          <ul style={{ color: "#b8c7dc", lineHeight: 2 }}>
            <li>任意Shell・任意Docker・任意RCONは受け付けません。</li>
            <li>同じIdempotency Keyは同じJobへ解決します。</li>
            <li>再起動・停止・バックアップなどの競合操作は同時作成しません。</li>
            <li>Jobの状態遷移は許可済みの順序だけを受理します。</li>
            <li>監査ログはハッシュチェーン付きの追記専用です。</li>
            <li>Secret・パスワード・Token・完全なコマンド文字列は保存しません。</li>
          </ul>
        </section>
      </section>
    </main>
  );
}

const cardStyle = {
  border: "1px solid rgba(148,163,184,.22)",
  borderRadius: 18,
  padding: 20,
  background: "rgba(15, 27, 45, .82)",
} as const;

const labelStyle = {
  display: "block",
  color: "#8ba4c7",
  fontSize: 12,
  letterSpacing: ".08em",
  marginBottom: 10,
} as const;

const valueStyle = {
  display: "block",
  fontSize: 24,
  overflowWrap: "anywhere",
} as const;

const termStyle = {
  color: "#8294ad",
  fontSize: 13,
} as const;

const descriptionStyle = {
  margin: 0,
  color: "#dbeafe",
  overflowWrap: "anywhere",
} as const;
