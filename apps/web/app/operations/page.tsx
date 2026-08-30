import {
  ActionLink,
  MetricCard,
  MetricGrid,
  PageContent,
  PageHeader,
  SectionHeader,
  StatePanel,
  StatusBadge,
  type ConsoleTone,
} from "../../components/console-ui";
import {
  getConsoleSession,
  type ConsoleRole,
} from "../../lib/console-auth";
import {
  getOperationCapabilities,
  type OperationRisk,
} from "../../lib/operation-catalog";
import styles from "./operations.module.css";

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

const lockLabels = {
  world: "ワールド保存",
  exclusive: "Minecraft排他操作",
  maintenance: "メンテナンス状態",
} as const;

function riskTone(risk: OperationRisk): ConsoleTone {
  if (risk === "low") return "success";
  if (risk === "medium") return "info";
  if (risk === "high") return "warning";
  return "danger";
}

export default async function OperationsPage() {
  const session = await getConsoleSession();
  const capabilities = getOperationCapabilities(session);
  const allowedCount = capabilities.filter((capability) => capability.allowed).length;

  return (
    <PageContent className={styles.content}>
      <PageHeader
        className={styles.pageHeader}
        eyebrow="SAFE OPERATIONS FOUNDATION"
        title="操作基盤"
        description="許可済み操作、必要ロール、二段階確認、冪等性、排他制御の設計を確認します。現在は読み取り専用で、OCI上のDocker・RCON・Shell操作は実行しません。"
        actions={<ActionLink href="/security">認証・権限を確認</ActionLink>}
      />

      <StatePanel title="実行機能は未接続です" variant="info">
        Job Queueと監査基盤のみを準備しています。専用Minecraft管理Agentが完成するまで、ボタンや変更APIは有効化しません。
      </StatePanel>

      <MetricGrid className={styles.metricGrid} label="操作基盤サマリー">
        <MetricCard label="AUTH MODE" value={session.mode} detail="Console authentication mode" />
        <MetricCard
          label="WEB ROLE"
          value={session.role ? roleLabels[session.role] : "未割当"}
          detail="Web console RBAC"
        />
        <MetricCard
          label="ALLOWED"
          value={`${allowedCount} / ${capabilities.length}`}
          detail="現在のSessionで許可される定義"
          tone={allowedCount > 0 ? "success" : "neutral"}
        />
        <MetricCard
          label="EXECUTION"
          value="無効"
          detail="Read-only foundation"
          tone="neutral"
        />
      </MetricGrid>

      <section aria-label="許可済み操作カタログ">
        <SectionHeader
          eyebrow="CAPABILITY CATALOG"
          title="許可済み操作の設計"
          description="画面はcapability定義と現在Sessionの判定を表示するだけで、実行APIは呼び出しません。"
        />
        <div className={styles.capabilityList}>
          {capabilities.map((capability) => {
            const authenticated = session.status === "authenticated";
            const availability = authenticated
              ? capability.allowed
                ? "権限あり"
                : "権限なし"
              : "認証有効化後に判定";

            return (
              <article className={styles.capabilityCard} key={capability.type}>
                <div className={styles.capabilityIdentity}>
                  <p className={styles.capabilityType}>{capability.type}</p>
                  <h3>{capability.label}</h3>
                  <StatusBadge tone={riskTone(capability.risk)}>
                    危険度 {riskLabels[capability.risk]}
                  </StatusBadge>
                </div>

                <div>
                  <p className={styles.capabilityDescription}>{capability.description}</p>
                  <dl className={styles.detailList}>
                    <dt>必要ロール</dt>
                    <dd>{roleLabels[capability.requiredRole]}</dd>
                    <dt>二段階確認</dt>
                    <dd>{capability.requiresConfirmation ? "確認文字列が必要" : "不要"}</dd>
                    <dt>排他区分</dt>
                    <dd>{lockLabels[capability.lockCategory]}</dd>
                    <dt>現在の判定</dt>
                    <dd>
                      <StatusBadge
                        tone={authenticated && capability.allowed ? "success" : "neutral"}
                      >
                        {availability}
                      </StatusBadge>
                    </dd>
                  </dl>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className={styles.safetyPanel} aria-label="操作基盤の安全設計">
        <SectionHeader
          eyebrow="SAFETY BOUNDARY"
          title="安全設計"
          description="操作機能を接続する場合も、現在のallowlistと監査境界を維持します。"
        />
        <ul>
          <li>任意Shell・任意Docker・任意RCONは受け付けません。</li>
          <li>同じIdempotency Keyは同じJobへ解決します。</li>
          <li>再起動・停止・バックアップなどの競合操作は同時作成しません。</li>
          <li>Jobの状態遷移は許可済みの順序だけを受理します。</li>
          <li>監査ログはハッシュチェーン付きの追記専用です。</li>
          <li>Secret・パスワード・Token・完全なコマンド文字列は保存しません。</li>
        </ul>
      </section>
    </PageContent>
  );
}
