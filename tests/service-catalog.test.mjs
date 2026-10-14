import test from "node:test";
import assert from "node:assert/strict";
import { BRAND_SERVICES, combineServiceHealth } from "../apps/web/lib/service-catalog.ts";

test("partial observations and stale failures never establish service health", () => {
  assert.equal(combineServiceHealth([]), "unknown");
  assert.equal(combineServiceHealth(["operational", "unknown"]), "unknown");
  assert.equal(combineServiceHealth(["unknown", "attention"]), "attention");
  assert.equal(combineServiceHealth(["operational", "operational"]), "operational");
});

test("required service topology is scoped to the observed host and excludes completed jobs", () => {
  assert.equal(new Set(BRAND_SERVICES.map(x => x.id)).size, BRAND_SERVICES.length);
  assert.equal(new Set(BRAND_SERVICES.map(x => x.domain)).size, BRAND_SERVICES.length);
  for (const service of BRAND_SERVICES) {
    assert.match(service.domain, /^(?:[a-z0-9-]+\.)?ivrm\.jp$/);
    assert.equal(new Set([...service.containers, ...service.dependencies]).size, service.containers.length + service.dependencies.length);
    assert.ok(!service.containers.some(name => /migrator|lovelace|mc-resource$/.test(name)));
    if (!service.serverId) assert.equal(service.containers.length, 0);
  }
  assert.ok(BRAND_SERVICES.find(x => x.id === "member").dependencies.includes("ivrm-api"));
  assert.ok(BRAND_SERVICES.find(x => x.id === "herta").dependencies.includes("herta-postgres-1"));
});
