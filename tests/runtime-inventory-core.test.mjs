import test from "node:test";
import assert from "node:assert/strict";
import { RUNTIME_CONTAINERS, parseRuntimeInventory, runtimeOnlySecrets } from "../apps/web/lib/runtime-inventory-core.ts";
const now = Date.parse("2026-10-15T00:00:00Z");
const make = () => ({ kind: "runtime-inventory-v1", serverId: "aws-app-01", observedAt: new Date(now).toISOString(), containers: RUNTIME_CONTAINERS["aws-app-01"].map(name => ({ name, collection: "ok", state: "running", health: "none", restartCount: 0, oomKilled: false, exitCode: 0, image: "registry.example/service:commit", imageId: "sha256:"+"a".repeat(64) })) });
const parse = x => parseRuntimeInventory(new TextEncoder().encode(JSON.stringify(x)), now);
test("accepts only complete host-scoped projection and explicit unavailable observations", () => {
  assert.equal(parse(make()).containers.length, 8);
  const x=make(); x.containers[0]={name:x.containers[0].name,collection:"unavailable"};
  assert.equal(parse(x).containers[0].collection,"unavailable");
});
test("rejects secrets, cross-host container names, duplicate/missing names and alternate protocols", () => {
  for (const mutate of [x=>x.kind="heartbeat",x=>x.serverId="constructor",x=>x.containers.pop(),x=>x.containers[1]=x.containers[0],x=>x.containers[0].name="mc-main",x=>x.containers[0].env="secret",x=>x.containers[0].image="https://user:secret@host/?key=x",x=>x.containers[0].restartCount=true,x=>x.containers[0].oomKilled="false",x=>x.containers[0].exitCode=256,x=>x.containers[0].imageId="sha256:fake",x=>x.containers[0]={name:x.containers[0].name,collection:"unavailable",state:"running"}]) {
    const x=make(); mutate(x); assert.throws(()=>parse(x));
  }
});
test("rejects stale, future and timezone-ambiguous runtime inventory",()=>{
  for(const time of [new Date(now-300001).toISOString(),new Date(now+30001).toISOString(),"2026-10-15T00:00:00","invalid"]) {
    const x=make();x.observedAt=time;assert.throws(()=>parse(x));
  }
});
test("dedicated runtime credential cannot supply another host's identity", () => {
  assert.deepEqual(runtimeOnlySecrets("lightsail-herta", "a".repeat(64)), { "lightsail-herta": "a".repeat(64) });
  for (const host of ["aws-app-01", "oci-minecraft-01", "constructor"]) assert.throws(() => runtimeOnlySecrets(host, "a".repeat(64)));
  for (const key of [undefined, "short", "a".repeat(65)]) assert.throws(() => runtimeOnlySecrets("lightsail-herta", key));
});
