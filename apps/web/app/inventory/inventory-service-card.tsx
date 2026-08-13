import type { InventoryNetworkService } from "../../lib/inventory";
import { statusClass } from "./inventory-format";
import styles from "./inventory.module.css";

export function InventoryServiceCard({ service }: { service: InventoryNetworkService }) {
  return (
    <article className={styles.serviceCard}>
      <div className={styles.cardHeader}>
        <div><span>{service.exposure.toUpperCase()}</span><h3>{service.name}</h3></div>
        <span className={`${styles.badge} ${statusClass(service.status)}`}>{service.status}</span>
      </div>
      <strong className={styles.endpoint}>{service.endpoint} / {service.protocol}</strong>
      <p>{service.note}</p>
    </article>
  );
}
