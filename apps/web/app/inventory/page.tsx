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
    <>
      <AutoRefresh intervalMs={30_000} />
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
    </>
  );
}
