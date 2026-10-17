import assert from "node:assert/strict";
import test from "node:test";
import { serializeLogEntries } from "../apps/web/lib/log-export.ts";

const entry = {
  id: 42, serverId: "test-host", hostDisplayName: "Test Host",
  sourceType: "container", sourceName: "mc-main", level: "info",
  observedAt: "2026-10-17T09:00:00Z", receivedAt: "2026-10-17T09:00:01Z",
  message: '日本語 "quoted" \\ line\nnext <script>alert(1)</script>',
};

test("JSONL preserves Unicode, multiline messages and timestamps as one record per entry", () => {
  const output = serializeLogEntries([entry, { ...entry, id: 43 }], "jsonl");
  const lines = output.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).message, entry.message);
  assert.equal(JSON.parse(lines[0]).observedAt, entry.observedAt);
  assert.equal(JSON.parse(lines[1]).id, 43);
});

test("export explicitly allows fields, excluding unexpected server metadata", () => {
  const output = serializeLogEntries([{ ...entry, token: "do-not-export", metadata: { secret: "private" } }], "jsonl");
  assert.deepEqual(Object.keys(JSON.parse(output)).sort(),
    ["id", "observedAt", "receivedAt", "serverId", "sourceType", "sourceName", "level", "message"].sort());
  assert.ok(!output.includes("do-not-export"));
  assert.ok(!output.includes("private"));
});

test("TXT includes source, full time and message without changing content", () => {
  assert.equal(serializeLogEntries([entry], "txt"),
    `${entry.observedAt} [test-host/mc-main] [info] ${entry.message}\n`);
});

test("empty input stays empty", () => {
  assert.equal(serializeLogEntries([], "txt"), "");
  assert.equal(serializeLogEntries([], "jsonl"), "");
});
