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
import { OperationLifecyclePanel } from "../../components/operation-lifecycle-panel";
import { getConsoleSession, type ConsoleRole } from "../../lib/console-auth";
import {
  getOperationCapabilities,
  getOperationDefinition,
  type OperationRisk,
} from "../../lib/operation-catalog";
import {
  listDiscordOperationJobs,
  MC_MAIN_OPERATION_ACTIONS,
} from "../../lib/mc-main-operations";
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
  const requestsEnabled = process.env.IVRM_OPERATION_REQUESTS_ENABLED?.trim().toLowerCase() === "true";
  const discordMutationAvailable = session.status === "authenticated" && session.authProvider === "discord";
  const lifecycleRequestsEnabled = requestsEnabled && discordMutationAvailable;
  const phaseB1Definitions = MC_MAIN_OPERATION_ACTIONS.map((action) => getOperationDefinition(action));
  const phaseB1Actions = phaseB1Definitions.map((definition) => ({
    action: definition.type as "start_backend" | "restart_backend" | "stop_backend",
    label: definition.label,
    description: definition.description,
    confirmationPhrase: definition.confirmationPhrase,
    requiredRoleLabel: roleLabels[definition.requiredRole],
    allowed: discordMutationAvailable && (capabilities.find((item) => item.type === definition.type)?.allowed ?? false),
  }));

  let jobs: Awaited<ReturnType<typeof listDiscordOperationJobs>> = [];
  let jobsLoadError = false;
  if (discordMutationAvailable && session.discordUserId) {
    try {
      jobs = await listDiscordOperationJobs(session.discordUserId);
    } catch {
      jobsLoadError = true;
    }
  }
  const activeCount = jobs.filter((job) => ["queued", "leased", "running"].includes(job.status)).length;

  return (
    <PageContent className={styles.content}>
      <PageHeader
        className={styles.pageHeader}
        eyebrow="SAFE LIFECYCLE OPERATIONS"
        title="操作基盤"
        description="mc-mainの起動・再起動・停止だけを固定Allowlistで実行します。任意Shell・任意Docker・任意RCONは公開せず、Operation Job / Lease / Audit基盤を再利用します。"
        actions={
          <>
            <ActionLink href="/logs?source=mc-main">mc-main Logs</ActionLink>
            <ActionLink href="/security">認証・権限を確認</ActionLink>
          </>
        }
      />

      {!requestsEnabled ? (
        <StatePanel title="Operation request gateはOFFです" variant="info">
          IVRM_OPERATION_REQUESTS_ENABLED=trueへ明示変更するまでBrowserからJobを作成しません。OCI側にも独立したexecution gateがあります。
        </StatePanel>
      ) : null}
      {requestsEnabled && discordMutationAvailable ? (
        <StatePanel title="Operation request gateはONです" variant="info">
          BrowserからPhase B-1のJob作成が可能です。実行はDiscord RBACとOCI側の独立したexecution gateでも制御されます。
        </StatePanel>
      ) : null}
      {requestsEnabled && !discordMutationAvailable ? (
        <StatePanel title="Lifecycle mutationにはDiscord Sessionが必要です" variant="info">
          Phase B-1のmutationはDiscord Session / Guild Role RBACへ固定しています。Cloudflare AccessのみのSessionでは実行要求を作成しません。
        </StatePanel>
      ) : null}
      {jobsLoadError ? (
        <StatePanel title="Operation progressを取得できません" variant="warning">
          操作要求は実行せず、DB / Session / Production migrationを確認してください。
        </StatePanel>
      ) : null}

      <MetricGrid className={styles.metricGrid} label="操作基盤サマリー">
        <MetricCard label="AUTH" value={session.authProvider} detail="Discord Session / RBAC" />
        <MetricCard
          label="WEB ROLE"
          value={session.role ? roleLabels[session.role] : "未割当"}
          detail="Web console RBAC"
        />
        <MetricCard
          label="PHASE B-1"
          value={`${phaseB1Actions.filter((item) => item.allowed).length} / 3`}
          detail="現在Sessionで許可されるmc-main操作"
          tone={phaseB1Actions.some((item) => item.allowed) ? "success" : "neutral"}
        />
        <MetricCard
          label="ACTIVE JOB"
          value={activeCount}
          detail="queued / leased / running"
          tone={activeCount > 0 ? "warning" : "neutral"}
        />
      </MetricGrid>

      <section aria-label="mc-main Safe Lifecycle">
        <SectionHeader
          eyebrow="PHASE B-1 / MC-MAIN"
          title="Safe Lifecycle Execution"
          description="targetはmc-main固定です。startはoperator以上、restartはoperator以上 + RESTART、stopはadministrator以上 + STOPを要求します。"
        />
        <OperationLifecyclePanel actions={phaseB1Actions} initialJobs={jobs} requestsEnabled={lifecycleRequestsEnabled} />
      </section>

      <section aria-label="許可済み操作カタログ">
        <SectionHeader
          eyebrow="CAPABILITY CATALOG"
          title="Operation Catalog"
          description="Phase B-1以外の操作は既存定義を表示しますが、今回のExecution Bridgeには接続しません。"
        />
        <div className={styles.capabilityList}>
          {capabilities.map((capability) => {
            const authenticated = session.status === "authenticated";
            const phaseB1 = MC_MAIN_OPERATION_ACTIONS.includes(
              capability.type as (typeof MC_MAIN_OPERATION_ACTIONS)[number],
            );
            const executable = authenticated && capability.allowed && phaseB1 && discordMutationAvailable;
            const availability = authenticated
              ? capability.allowed
                ? phaseB1
                  ? discordMutationAvailable
                    ? "B-1実行対象"
                    : "Discord Sessionが必要"
                  : "権限あり / 未接続"
                : "権限なし"
              : "認証後に判定";

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
                    <dt>必要ロール</dt><dd>{roleLabels[capability.requiredRole]}</dd>
                    <dt>二段階確認</dt><dd>{capability.requiresConfirmation ? "確認文字列が必要" : "不要"}</dd>
                    <dt>排他区分</dt><dd>{lockLabels[capability.lockCategory]}</dd>
                    <dt>現在の判定</dt>
                    <dd><StatusBadge tone={executable ? "success" : "neutral"}>{availability}</StatusBadge></dd>
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
          description="Browser → Queue → HMAC Agent → fixed root helperの各境界でAllowlistを重ねます。"
        />
        <ul>
          <li>Browserからcontainer名、systemd unit名、Shell、Docker command、RCON commandを入力できません。</li>
          <li>同じIdempotency Keyは同じJobへ解決し、Minecraft排他操作はactive lockで409になります。</li>
          <li>AgentはHMAC / timestamp / nonce replay ledgerを通過したrequestだけclaim / transitionします。</li>
          <li>root helperはmc-mainと3 lifecycle actionだけを固定実行します。</li>
          <li>stop/restartはSIGTERM後の停止を待ち、timeout時にSIGKILLへ自動昇格しません。</li>
          <li>start/restartはDocker Health=healthyまで成功扱いにしません。</li>
          <li>Secret・private IP・raw commandはJob / Audit / UIへ保存しません。</li>
        </ul>
      </section>
    </PageContent>
  );
}
