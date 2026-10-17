import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BRAND_SERVICES } from "../apps/web/lib/service-catalog.ts";
import { CONSOLE_LOG_SOURCES } from "../apps/web/lib/console-log-types.ts";

const inventory = JSON.parse(await readFile(new URL("../catalog/telemetry-sources.json", import.meta.url), "utf8"));
const sourceById = new Map(inventory.sources.map(source => [source.id, source]));

test("inventory remains planning data and cannot enable collection or authorize a source", () => {
  assert.equal(inventory.purpose, "planning-only-not-an-authorization-registry");
  assert.equal(sourceById.size, inventory.sources.length);
  const owners = new Set(inventory.repositories.map(repo => repo.repository));
  const services = new Set(BRAND_SERVICES.map(service => service.id));
  for (const source of inventory.sources) {
    assert.equal(source.enablesCollection, false, source.id);
    assert.ok(owners.has(source.ownerRepository), source.id);
    assert.ok(["planned", "needs_discovery", "legacy_configured"].includes(source.logState));
    assert.ok(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(source.id));
    assert.ok(source.serviceIds.length > 0);
    for (const serviceId of source.serviceIds) assert.ok(services.has(serviceId), serviceId);
  }
});

test("every catalog container and dependency has a host-scoped log coverage entry", () => {
  for (const service of BRAND_SERVICES) {
    if (!service.serverId) continue;
    for (const name of [...service.containers, ...service.dependencies]) {
      const source = sourceById.get(`${service.serverId}.${name}`);
      assert.ok(source, `Missing ${service.serverId}/${name}`);
      assert.ok(source.serviceIds.includes(service.id), `Missing dependency relation for ${service.id}/${name}`);
    }
  }
});

test("legacy configured sources are distinguished from unconnected provider adapters", () => {
  for (const source of CONSOLE_LOG_SOURCES) {
    const row = sourceById.get(`oci-minecraft-01.${source.name}`);
    assert.equal(row?.logState, "legacy_configured");
    assert.equal(row?.type, source.type);
  }
  for (const source of inventory.sources.filter(source => source.hostId === null)) {
    assert.equal(source.logState, "needs_discovery");
  }
  assert.equal(inventory.repositories.find(repo => repo.repository === "ivRooom/ivrm-ai")?.kind, "needs_discovery");
  assert.equal(inventory.repositories.find(repo => repo.repository === "ivRooom/ivrm-mail-discord-worker")?.kind, "archived");
});
