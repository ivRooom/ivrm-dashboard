import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { handleTelemetryRequest } from "../apps/web/lib/telemetry-ingest.ts";

const exec = promisify(execFile);
const container = process.env.TELEMETRY_TEST_CONTAINER;
const databaseUrl = process.env.TELEMETRY_TEST_DATABASE_URL;
if (container) {
  const label = execFileSync("docker", ["inspect", "--format", '{{index .Config.Labels "ivrm.task"}}', container], { encoding: "utf8" }).trim();
  assert.equal(label, "telemetry-foundation", "Refusing to write to a container without the dedicated task label");
} else {
  const url = new URL(databaseUrl ?? "invalid:");
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol) && ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/telemetry_test",
    "Only explicitly configured disposable loopback telemetry_test databases are accepted");
}
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
async function sql(query) {
  const command = container ? "docker" : "psql";
  const args = container ? ["exec", container, "psql", "-U", "postgres", "-d", "telemetry_test", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", query] :
    [databaseUrl, "-Atq", "-v", "ON_ERROR_STOP=1", "-c", query];
  return (await exec(command, args, { maxBuffer: 1024 * 1024 })).stdout.trim();
}
const secret = "a".repeat(64);
async function producer(options = {}) {
  const id = `fixture-${randomBytes(6).toString("hex")}`;
  await sql(`insert into ivrm_telemetry.producers(id,enabled) values(${quote(id)},true);
    insert into ivrm_telemetry.sources(producer_id,source_id,service_id,source_type,provider,host_id,resource_id,enabled)
    values(${quote(id)},'logs','fixture','container','oci','fixture-host','fixture-container',true);`);
  if (options.maxEvents) await sql(`update ivrm_telemetry.producers set max_events=${options.maxEvents} where id=${quote(id)}`);
  return id;
}
const event = () => ({ eventId: randomUUID(), observedAt: new Date().toISOString(), source: {
  serviceId: "fixture", sourceId: "logs", type: "container", provider: "oci", hostId: "fixture-host", resourceId: "fixture-container",
}, kind: "log", level: "info", outcome: "observed", message: "fixture message" });
const batch = (id, events = [event()]) => ({ schemaVersion: 1, producerId: id, batchId: randomUUID(), events });
async function ingest(value, nonce = randomBytes(16).toString("hex")) {
  const raw = JSON.stringify(value), timestamp = String(Math.floor(Date.now()/1000));
  const signature = createHmac("sha256",secret).update(`POST\n/api/agent/telemetry\n${value.producerId}\n${timestamp}\n${nonce}\n${raw}`).digest("hex");
  const request = new Request("https://fixture.invalid/api/agent/telemetry", { method: "POST", body: raw,
    headers: { "Content-Type": "application/json", "X-IVRM-Producer-ID": value.producerId, "X-IVRM-Timestamp": timestamp, "X-IVRM-Nonce": nonce, "X-IVRM-Signature": signature } });
  const response = await handleTelemetryRequest(request, {
    enabled: true, secrets: () => ({ [value.producerId]: secret }),
    persist: async input => JSON.parse(await sql(`set role service_role; select public.ingest_operational_telemetry_v1(
      ${quote(input.producerId)},${quote(input.batchId)}::uuid,${quote(input.nonce)},${quote(input.bodySha256)},${quote(JSON.stringify(input.events))}::jsonb)`)),
  });
  return { status: response.status, body: await response.json() };
}
const eventCount = async id => Number(await sql(`select count(*) from ivrm_telemetry.events where producer_id=${quote(id)}`));

test("real PG transaction handles nonce, raw-batch replay and canonical event duplicates", async () => {
  const id = await producer(), value = batch(id), nonce = randomBytes(16).toString("hex");
  const first = await ingest(value, nonce); assert.equal(first.status,202); assert.equal(first.body.acceptedEvents,1);
  assert.equal((await ingest(value,nonce)).status,401);
  const replay = await ingest(value); assert.equal(replay.status,200); assert.equal(replay.body.replayed,true);
  assert.equal((await ingest({ ...value, events: [{ ...value.events[0], message: "changed" }] })).status,409);
  const reordered = Object.fromEntries(Object.entries(value.events[0]).reverse());
  const duplicate = await ingest(batch(id,[reordered]));
  assert.equal(duplicate.status,202); assert.equal(duplicate.body.acceptedEvents,0); assert.equal(duplicate.body.duplicateEvents,1);
  assert.equal(await eventCount(id),1);
});

test("unauthorized second event and late conflicts cannot partially persist a batch", async () => {
  const id = await producer(), original = batch(id); await ingest(original);
  const unauthorized = event(); unauthorized.source.serviceId = "other-service";
  assert.equal((await ingest(batch(id,[event(),unauthorized]))).status,403);
  const changed = { ...original.events[0], message: "conflicting event" };
  assert.equal((await ingest(batch(id,[event(),changed]))).status,409);
  assert.equal(await eventCount(id),1);
});

test("actor and client-IP ingestion require explicit source capabilities", async () => {
  const id = await producer(), value = batch(id);
  value.events[0].clientIp = { address: "192.0.2.10", provenance: "verified_edge" };
  assert.equal((await ingest(value)).status,403);
  delete value.events[0].clientIp; value.events[0].actor = { type: "human", provider: "fixture", displayName: "password=private" };
  assert.equal((await ingest(value)).status,403);
  await sql(`update ivrm_telemetry.sources set allow_actor=true where producer_id=${quote(id)}`);
  assert.equal((await ingest(value)).status,202);
  const stored = await sql(`select event::text from ivrm_telemetry.events where producer_id=${quote(id)}`);
  assert.ok(!stored.includes("private"));
  await sql(`update ivrm_telemetry.sources set enabled=false where producer_id=${quote(id)}`);
  assert.equal((await ingest(batch(id))).status,403);
});

test("request and durable-capacity limits reject without losing accepted events", async () => {
  const id = await producer({ maxEvents: 1 }); await ingest(batch(id));
  assert.equal((await ingest(batch(id))).status,429); assert.equal(await eventCount(id),1);
  await sql(`update ivrm_telemetry.producers set request_count=requests_per_minute where id=${quote(id)}`);
  assert.equal((await ingest(batch(id))).status,429);
});

test("eight independent connections accept the same batch only once", async () => {
  const id = await producer(), value = batch(id);
  const results = await Promise.all(Array.from({ length: 8 }, () => ingest(value)));
  assert.equal(results.filter(result => result.status === 202).length,1);
  assert.equal(results.filter(result => result.status === 200).length,7);
  assert.equal(await eventCount(id),1);
  assert.equal(Number(await sql(`select count(*) from ivrm_telemetry.batches where producer_id=${quote(id)}`)),1);
});

test("capacity remains atomic across concurrent batches", async () => {
  const id = await producer({ maxEvents: 1 });
  const results = await Promise.all(Array.from({ length: 8 }, () => ingest(batch(id))));
  assert.equal(results.filter(result => result.status === 202).length,1);
  assert.equal(results.filter(result => result.status === 429).length,7);
  assert.equal(await eventCount(id),1);
});

test("a failure after event insertion rolls back events, batch, nonce and counters", async () => {
  const id = await producer();
  await sql(`create or replace function ivrm_telemetry.fixture_fail_batch() returns trigger language plpgsql as $$ begin raise exception 'fixture forced failure'; end $$;
    create trigger fixture_fail_batch before insert on ivrm_telemetry.batches for each row when (new.producer_id=${quote(id)}) execute function ivrm_telemetry.fixture_fail_batch()`);
  try {
    const response = await ingest(batch(id));
    assert.equal(response.status,503);
    assert.deepEqual(response.body,{ accepted:false,code:"storage_unavailable" });
    assert.equal(await eventCount(id),0);
    assert.equal(await sql(`select batch_count,event_count,request_count from ivrm_telemetry.producers where id=${quote(id)}`),"0|0|0");
    assert.equal(await sql(`select count(*) from ivrm_telemetry.nonces where producer_id=${quote(id)}`),"0");
  } finally { await sql("drop trigger fixture_fail_batch on ivrm_telemetry.batches; drop function ivrm_telemetry.fixture_fail_batch()"); }
});

test("browser roles cannot execute ingest or read private events; service role has RPC only", async () => {
  for (const role of ["anon", "authenticated"]) {
    const privileges = await sql(`select has_function_privilege('${role}','public.ingest_operational_telemetry_v1(text,uuid,text,text,jsonb)','execute'),
      has_schema_privilege('${role}','ivrm_telemetry','usage'),has_table_privilege('${role}','ivrm_telemetry.events','select')`);
    assert.equal(privileges,"f|f|f");
  }
  assert.equal(await sql("select has_function_privilege('service_role','public.ingest_operational_telemetry_v1(text,uuid,text,text,jsonb)','execute'),has_table_privilege('service_role','ivrm_telemetry.events','select')"),"t|f");
  assert.equal(Number(await sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='ivrm_telemetry' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity")),5);
});
