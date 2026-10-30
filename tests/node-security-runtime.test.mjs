import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../package.json", import.meta.url);

test("Console CI executes patched Node.js 24 LTS", () => {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  assert.equal(major, 24);
  assert.ok(minor > 22 || (minor === 22 && patch >= 2));
});

test("Console accepts only supported security-patched Node.js lines", () => {
  const manifest = JSON.parse(readFileSync(root, "utf8"));
  assert.equal(manifest.engines.node, "^22.23.4 || ^24.22.2 || ^26.13.0");
});
