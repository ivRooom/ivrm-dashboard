import type { InfrastructureInventory } from "../../lib/inventory";
import { bytes } from "./inventory-format";
import styles from "./inventory.module.css";

export function InventorySummary({ data }: { data: InfrastructureInventory }) {
  return (
    <section className={styles.summaryGrid} aria-label="Inventoryサマリー">
      <article><span>HOSTS</span><strong>{data.summary.hostCount}</strong><small>Agent upgrade {data.summary.agentUpgradeRecommendedCount}</small></article>
      <article><span>CONTAINERS</span><strong>{data.summary.containerCount}</strong><small>Unmanaged {data.summary.unmanagedContainerCount}</small></article>
      <article className={data.summary.attentionCount > 0 ? styles.attention : undefined}><span>ATTENTION</span><strong>{data.summary.attentionCount}</strong><small>Host + Container</small></article>
      <article><span>MAINTENANCE</span><strong>{data.summary.maintenanceCount}</strong><small>Active maintenance</small></article>
      <article><span>CPU CAPACITY</span><strong>{data.summary.cpuCoreCount}</strong><small>Observed cores</small></article>
      <article><span>MEMORY / DISK</span><strong>{bytes(data.summary.memoryTotalBytes)}</strong><small>{bytes(data.summary.diskTotalBytes)} disk</small></article>
    </section>
  );
}
