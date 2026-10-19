import test from "node:test";
import assert from "node:assert/strict";
import { assessFilesystemCapacity } from "../apps/telemetry-sender/filesystem-health.ts";

const stats = { bsize: 4096n, blocks: 1_000_000n, bavail: 500_000n, files: 1000n, ffree: 500n };
test("uses available blocks and detects both absolute and proportional disk pressure", () => {
  assert.deepEqual(assessFilesystemCapacity(stats).reasons,[]);
  assert.equal(assessFilesystemCapacity(stats).availableBytes,2_048_000_000);
  assert.deepEqual(assessFilesystemCapacity({...stats,bavail:0n}).reasons,["filesystem_capacity"]);
  assert.deepEqual(assessFilesystemCapacity({...stats,bavail:49_999n}).reasons,["filesystem_capacity"]);
  assert.deepEqual(assessFilesystemCapacity({...stats,blocks:20_000n,bavail:10_000n}).reasons,["filesystem_capacity"]);
});
test("zero reported inode limit remains unknown; exhausted fixed inode limit alerts", () => {
  assert.deepEqual(assessFilesystemCapacity({...stats,files:0n,ffree:0n}).reasons,[]);
  assert.equal(assessFilesystemCapacity({...stats,files:0n,ffree:0n}).inodeAvailability,"not-reported");
  assert.deepEqual(assessFilesystemCapacity({...stats,ffree:0n}).reasons,["filesystem_inodes"]);
});
test("invalid or unrepresentable capacity is never interpreted as healthy", () => {
  for (const change of [{bsize:0n},{blocks:0n},{bavail:-1n},{bavail:1_000_001n},{ffree:1001n},{bsize:1},{blocks:BigInt(Number.MAX_SAFE_INTEGER)}]) {
    assert.throws(()=>assessFilesystemCapacity({...stats,...change}),/invalid_filesystem_capacity/);
  }
});
