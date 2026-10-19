import { statfsSync } from "node:fs";

type Capacity = { bsize: bigint; blocks: bigint; bavail: bigint; files: bigint; ffree: bigint };

/** Available-to-caller blocks, not root's reserved free blocks. Never return mount paths. */
export function assessFilesystemCapacity(stats: Capacity) {
  if ([stats.bsize,stats.blocks,stats.bavail,stats.files,stats.ffree].some(value => typeof value !== "bigint" || value < 0n) ||
      stats.bsize === 0n || stats.blocks === 0n || stats.bavail > stats.blocks || stats.ffree > stats.files) throw new Error("invalid_filesystem_capacity");
  const total = stats.bsize * stats.blocks, available = stats.bsize * stats.bavail;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid_filesystem_capacity");
  const reasons: string[] = [];
  if (available < 64n * 1024n * 1024n || stats.bavail * 100n < stats.blocks * 5n) reasons.push("filesystem_capacity");
  // Some filesystems report zero inodes because there is no fixed inode limit.
  if (stats.files > 0n && stats.ffree * 100n < stats.files * 5n) reasons.push("filesystem_inodes");
  return { totalBytes: Number(total), availableBytes: Number(available),
    inodeAvailability: stats.files === 0n ? "not-reported" : "measured",
    reasons };
}

export function readFilesystemCapacity(directory: string) {
  return assessFilesystemCapacity(statfsSync(directory,{bigint:true}));
}
