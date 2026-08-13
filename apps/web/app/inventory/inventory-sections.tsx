import type { InfrastructureInventory } from "../../lib/inventory";
import { InventoryHostCard } from "./inventory-host-card";
import { InventoryServiceCard } from "./inventory-service-card";
import styles from "./inventory.module.css";

export function InventorySections({ data }: { data: InfrastructureInventory }) {
  return (
    <>
      {!data.minecraftDataAvailable ? <div className={styles.notice}>Minecraft Probeデータを取得できないため、Network Serviceの一部はUnknownです。Agent 0.5.0+配備後に自動反映されます。</div> : null}
      <section>
        <div className={styles.sectionTitle}><div><span>SERVICE EXPOSURE</span><h2>公開・内部サービス</h2></div><p>期待する公開境界だけを表示し、Secret・内部IP・Mountは収集しません。</p></div>
        <div className={styles.serviceGrid}>{data.services.map((service) => <InventoryServiceCard key={service.id} service={service} />)}</div>
      </section>
      <section>
        <div className={styles.sectionTitle}><div><span>ASSET CATALOG</span><h2>Host / Container資産</h2></div><p>{data.view === "attention" ? "Attention対象だけ表示しています。" : "現在有効なHostと最新Container Snapshotを表示します。"}</p></div>
        {data.hosts.length === 0 ? <div className={styles.empty}>表示条件に一致する資産はありません。</div> : data.hosts.map((host) => <InventoryHostCard key={host.id} host={host} />)}
      </section>
      <section className={styles.notice}><strong>Inventory coverage</strong><p>観測済みTelemetryだけを資産として扱います。Agent未受信・Probe未配備・Expectation未設定は推測で補完せず、UnknownまたはAttentionとして明示します。</p></section>
    </>
  );
}
