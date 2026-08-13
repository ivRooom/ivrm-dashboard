import { AutoRefresh } from "../../components/auto-refresh";
import { getInfrastructureInventory, parseInventoryView } from "../../lib/inventory";
import { InventorySections } from "./inventory-sections";
import { InventorySummary } from "./inventory-summary";
import styles from "./inventory.module.css";

export const dynamic = "force-dynamic";
type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] || null : value || null;

export default async function InventoryPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const view = parseInventoryView(first(query.view));
  let data = null;
  let loadError = false;
  try {
    data = await getInfrastructureInventory(view);
  } catch (error) {
    loadError = true;
    console.error("Infrastructure Inventoryの取得に失敗しました", error);
  }

  return (
    <main className="shell">
      <AutoRefresh intervalMs={30_000} />
      <aside className="sidebar">
        <a className="brand" href="/#top"><span>IV</span><strong>IVRM Console</strong></a>
        <nav aria-label="メインナビゲーション">
          <a href="/#top">概要</a><a href="/minecraft">Minecraft</a><a href="/hosts">ホスト</a>
          <a href="/containers">コンテナ</a><a href="/incidents">インシデント</a><a href="/backups">バックアップ</a>
          <a href="/notifications">通知</a><a href="/reliability">信頼性</a><a aria-current="page" href={`/inventory?view=${view}`}>インベントリ</a>
          <a href="/history">履歴グラフ</a>
        </nav>
        <div className="agent">
          <i className={loadError ? "error" : data && data.summary.attentionCount > 0 ? "stale" : "online"} />
          Infrastructure Inventory<br />
          <small>{loadError ? "取得エラー" : data ? `${data.summary.hostCount} hosts / ${data.summary.containerCount} containers` : "Loading"}</small>
        </div>
      </aside>

      <section className={`content ${styles.content}`}>
        <header className={styles.header}>
          <div><p className={styles.eyebrow}>INFRASTRUCTURE / ASSET INVENTORY</p><h1>Infrastructure Inventory</h1><p>Host・Container・公開サービス・Agent世代を横断し、現在観測できる資産と運用ギャップを一元管理します。</p></div>
          <div className={styles.actions}><a href="/hosts">Host一覧</a><a href="/containers">Container一覧</a><a href="/minecraft">Minecraft</a></div>
        </header>
        <nav className={styles.filters} aria-label="インベントリ表示条件">
          <a aria-current={view === "all" ? "page" : undefined} href="/inventory?view=all">すべて</a>
          <a aria-current={view === "attention" ? "page" : undefined} href="/inventory?view=attention">Attention only</a>
        </nav>
        {loadError || !data ? (
          <div className="empty error-panel" role="alert"><strong>Inventoryを取得できませんでした</strong><p>Monitoring SnapshotのServer-side接続を確認してください。</p></div>
        ) : <><InventorySummary data={data} /><InventorySections data={data} /></>}
      </section>
    </main>
  );
}
