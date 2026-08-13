import type { AgentCapability, InventoryHost } from "../../lib/inventory";
import styles from "./inventory.module.css";

export const agentLabels: Record<AgentCapability, string> = {
  current: "Current",
  upgrade_recommended: "Upgrade Recommended",
  unknown: "Unknown",
};

export function bytes(value: number | null): string {
  if (value === null) return "不明";
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unit = -1;
  do { size /= 1024; unit += 1; } while (size >= 1024 && unit < units.length - 1);
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function age(seconds: number | null): string {
  if (seconds === null) return "未受信";
  if (seconds < 60) return `${seconds}秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間前`;
  return `${Math.floor(seconds / 86400)}日前`;
}

export function percent(used: number | null, total: number | null): string {
  if (used === null || total === null || total <= 0) return "不明";
  return `${Math.max(0, Math.min(100, (used / total) * 100)).toFixed(1)}%`;
}

export function memoryUsed(host: InventoryHost): number | null {
  return host.memoryTotalBytes === null || host.memoryAvailableBytes === null ? null : Math.max(0, host.memoryTotalBytes - host.memoryAvailableBytes);
}

export function diskUsed(host: InventoryHost): number | null {
  return host.diskTotalBytes === null || host.diskAvailableBytes === null ? null : Math.max(0, host.diskTotalBytes - host.diskAvailableBytes);
}

export function statusClass(status: string): string {
  if (["online", "ready", "standby"].includes(status)) return styles.good;
  if (["maintenance", "stale"].includes(status)) return styles.warn;
  if (["error", "offline", "attention"].includes(status)) return styles.bad;
  return styles.unknown;
}
