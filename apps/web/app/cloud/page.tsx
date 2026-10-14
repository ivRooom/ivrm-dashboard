import { AutoRefresh } from "../../components/auto-refresh";
import { ActionLink, PageHeader, StatePanel, StatusBadge, TableShell } from "../../components/console-ui";
import { cloudHealth } from "../../lib/cloud-monitor-core";
import { getCloudTargets, type CloudTarget } from "../../lib/cloud-monitor";
import styles from "./cloud.module.css";

export const dynamic = "force-dynamic";
const labels = { operational: "正常", degraded: "劣化", outage: "停止・障害", unknown: "未確認", error: "取得失敗", stale: "収集停止" } as const;
const reasons: Record<string, string> = { ok: "取得成功", not_received: "未受信", not_configured: "認証設定が未完了", auth_error: "認証切れ・認証失敗", forbidden: "読み取り権限が不足", timeout: "応答時間超過", provider_error: "参照先から有効な応答を取得できません", not_found: "対象リソースを参照できません", unexpected_state: "期待する稼働状態と異なります", dns_mismatch: "DNS設定が期待値と異なります" };
export default async function CloudPage() {
  let targets: CloudTarget[] | null = null;
  try { targets = await getCloudTargets(); } catch { /* Render an explicit unavailable state. */ }
  const now = Date.now();
  return <section className="content">
    <AutoRefresh intervalMs={30_000} />
    <PageHeader title="クラウド監視" eyebrow="INFRASTRUCTURE / CLOUD" description="クラウド・公開サービスの状態と収集状況。取得失敗や未受信は正常として扱いません。"
      actions={<ActionLink href="/notifications">通知センター</ActionLink>} />
    {targets === null ? <StatePanel title="監視データを取得できません" variant="error">DB接続とCloud Monitorのマイグレーションを確認してください。</StatePanel> : targets.length === 0 ?
      <StatePanel title="監視対象が未登録です">Collector設定と監視対象の登録が必要です。</StatePanel> :
      <><p className={styles.hint}>狭い画面では表を横にスクロールして全項目を確認できます。</p>
      <TableShell label="クラウド監視対象"><table className={styles.table}><thead><tr><th scope="col">サービス</th><th scope="col">Provider</th><th scope="col">状態</th><th scope="col">取得結果</th><th scope="col">最終受信</th></tr></thead><tbody>
        {targets.map(target => {
          const status = cloudHealth(target.status, target.received_at, target.stale_after_seconds, now);
          return <tr key={target.id}><td>{target.display_name}</td><td>{target.provider}</td><td>
            <StatusBadge tone={!target.enabled ? "neutral" : status === "operational" ? "success" : status === "unknown" ? "neutral" : "danger"}>
              {target.enabled ? labels[status] : "監視無効"}</StatusBadge></td><td>{status === "stale" ? "Collectorからの受信が途絶えています" : reasons[target.reason_code] ?? "未確認"}</td>
            <td>{target.received_at ? new Date(target.received_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "未受信"}</td></tr>;
        })}
      </tbody></table></TableShell></>}
  </section>;
}
