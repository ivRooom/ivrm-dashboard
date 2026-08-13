import type { InventoryContainer, InventoryHost } from "../../lib/inventory";
import { age, agentLabels, bytes, diskUsed, memoryUsed, percent, statusClass } from "./inventory-format";
import styles from "./inventory.module.css";

function ContainerRow({ container }: { container: InventoryContainer }) {
  return (
    <tr>
      <td><a href={container.detailHref}><strong>{container.name}</strong></a><small>{container.roleLabel}</small></td>
      <td><span className={`${styles.badge} ${statusClass(container.status)}`}>{container.status}</span></td>
      <td>{container.state}<small>Health: {container.health}</small></td>
      <td>{container.expectedState ?? "未設定"}<small>{container.managed ? "Managed" : "Expectationなし"}</small></td>
      <td>{container.cpuPercent === null ? "不明" : `${container.cpuPercent.toFixed(1)}%`}<small>{bytes(container.memoryUsageBytes)} / {bytes(container.memoryLimitBytes)}</small></td>
      <td>{container.restartCount}<small>{container.oomKilled ? "OOMKilled" : `PIDs ${container.pids ?? "不明"}`}</small></td>
      <td>{age(container.ageSeconds)}<small>{container.maintenanceActive ? "Maintenance" : "Telemetry"}</small></td>
    </tr>
  );
}

export function InventoryHostCard({ host }: { host: InventoryHost }) {
  const usedMemory = memoryUsed(host);
  const usedDisk = diskUsed(host);
  return (
    <article className={styles.hostCard}>
      <div className={styles.hostHeader}>
        <div>
          <span className={styles.eyebrow}>{host.provider} / {host.environment}</span>
          <h3><a href={host.detailHref}>{host.displayName}</a></h3>
          <p>{host.serverId}</p>
        </div>
        <div className={styles.badges}>
          <span className={`${styles.badge} ${statusClass(host.status)}`}>{host.status}</span>
          <span className={`${styles.badge} ${host.agentCapability === "current" ? styles.good : styles.warn}`}>{agentLabels[host.agentCapability]}</span>
        </div>
      </div>
      <div className={styles.hostMetrics}>
        <div><span>AGENT</span><strong>{host.agentVersion ?? "不明"}</strong><small>{age(host.ageSeconds)}</small></div>
        <div><span>CPU</span><strong>{host.cpuCount ?? "不明"} cores</strong><small>Load1 {host.loadAverage1?.toFixed(2) ?? "不明"}</small></div>
        <div><span>MEMORY</span><strong>{percent(usedMemory, host.memoryTotalBytes)}</strong><small>{bytes(usedMemory)} / {bytes(host.memoryTotalBytes)}</small></div>
        <div><span>DISK</span><strong>{percent(usedDisk, host.diskTotalBytes)}</strong><small>{bytes(usedDisk)} / {bytes(host.diskTotalBytes)}</small></div>
        <div><span>MANAGED</span><strong>{host.managedContainerCount} / {host.containers.length}</strong><small>Expectation configured</small></div>
      </div>
      {host.containers.length === 0 ? (
        <div className={styles.empty}>表示対象Containerはありません。</div>
      ) : (
        <div className={styles.tableShell}>
          <table>
            <thead><tr><th>Container</th><th>Status</th><th>Runtime</th><th>Expected</th><th>Resources</th><th>Restarts</th><th>Freshness</th></tr></thead>
            <tbody>{host.containers.map((container) => <ContainerRow key={`${host.id}:${container.name}`} container={container} />)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}
