import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { TelemetrySpool } from "../apps/telemetry-sender/spool.ts";
import { handleTelemetryRequest } from "../apps/web/lib/telemetry-ingest.ts";

const secret = "a".repeat(64);
const producer = "fixture-producer";
const baseNow = Date.now();
function batch(now=baseNow) {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, producerId: producer, batchId: randomUUID(), events: [{
    eventId: randomUUID(), observedAt: new Date(now).toISOString(), source: {
      sourceId: "fixture-log", serviceId: "fixture", type: "container", provider: "oci",
    }, kind: "log", level: "info", outcome: "observed", message: "fixture" }]}));
}
function fixture(options={}) {
  const directory = mkdtempSync(join(tmpdir(),"ivrm-spool-"));
  const db = new TelemetrySpool(directory,producer,options);
  return { directory, db, cleanup() { db.close(); rmSync(directory,{recursive:true}); } };
}
function ack(request,status=202) {
  return request.json().then(b => Response.json({ accepted: true, batchId: b.batchId,
    acceptedEvents: b.events.length, duplicateEvents: 0, replayed: status===200 }, {status}));
}
test("restart retains immutable bytes; duplicate is idempotent and changed content conflicts", async () => {
  const f=fixture(); const raw=batch(); f.db.enqueue(raw); f.db.close();
  const reopened=new TelemetrySpool(f.directory,producer);
  try {
    assert.equal(reopened.enqueue(raw),"duplicate");
    const changed=JSON.parse(raw); changed.events[0].message="changed";
    assert.throws(()=>reopened.enqueue(Buffer.from(JSON.stringify(changed))),/content_conflict/);
    await reopened.deliver(secret,async request=>{assert.equal(Buffer.from(await request.clone().arrayBuffer()).compare(raw),0);return ack(request);});
    assert.equal(reopened.status()[0].state,"delivered");
    assert.equal(reopened.status()[0].bytes,0);
    assert.equal(reopened.enqueue(raw),"duplicate");
  } finally { reopened.close(); rmSync(f.directory,{recursive:true}); }
});
test("disk queue rejects overflow without evicting old evidence; producer binding survives reopen", () => {
  const f=fixture({maxRows:1});
  try {
    f.db.enqueue(batch()); assert.throws(()=>f.db.enqueue(batch()),/spool_full/);
    assert.equal(f.db.status()[0].batches,1);
    assert.throws(()=>new TelemetrySpool(f.directory,"another-producer"),/producer_mismatch/);
    assert.throws(()=>new TelemetrySpool(f.directory,producer),/configuration_mismatch/);
    const wrong=JSON.parse(batch()); wrong.producerId="another-producer";
    assert.throws(()=>f.db.enqueue(Buffer.from(JSON.stringify(wrong))),/producer_mismatch/);
  } finally { f.cleanup(); }
});
test("retry keeps body and batch ID but uses a fresh HMAC nonce, and respects Retry-After", async()=>{
  let now=baseNow; const f=fixture({now:()=>now}); const attempts=[]; f.db.enqueue(batch(now));
  const transport=async request=>{attempts.push({body:await request.clone().text(),nonce:request.headers.get("X-IVRM-Nonce")});
    if(attempts.length===1) return new Response(null,{status:429,headers:{"Retry-After":"120"}});
    return handleTelemetryRequest(request,{enabled:true,secrets:()=>({[producer]:secret}),now:()=>now,
      persist:async input=>({status:202,receipt:{accepted:true,batchId:input.batchId,replayed:false,acceptedEvents:input.events.length,duplicateEvents:0}})});
  };
  try {
    assert.equal(await f.db.deliver(secret,transport),"pending");
    now+=119_000; assert.equal(await f.db.deliver(secret,transport),"idle");
    now+=100_000; assert.equal(await f.db.deliver(secret,transport),"delivered");
    assert.equal(attempts[0].body,attempts[1].body); assert.notEqual(attempts[0].nonce,attempts[1].nonce);
  } finally {f.cleanup();}
});
test("malformed, mismatched and oversized ACKs never remove pending bytes",async()=>{
  for(const transport of [async()=>Response.json({accepted:true}),async request=>ack(request,200).then(async response=>new Response(await response.text(),{status:202})),
    async()=>new Response("x".repeat(2049),{status:202}),async()=>{throw new Error("private diagnostic");}]) {
    const f=fixture(); f.db.enqueue(batch());
    try {assert.equal(await f.db.deliver(secret,transport),"pending");assert.ok(f.db.status()[0].bytes>0);}
    finally {f.cleanup();}
  }
});
test("permanent rejection, attempt exhaustion and expired events stay blocked on disk",async()=>{
  for(const mode of ["rejected","attempts","expired"]) {
    let now=baseNow; const f=fixture({now:()=>now,maxAttempts:1});f.db.enqueue(batch(now));let calls=0;
    if(mode==="expired")now+=8*86400_000;
    try {
      await f.db.deliver(secret,async()=>{calls++;return new Response(null,{status:mode==="rejected"?403:503});});
      assert.equal(f.db.status()[0].state,"blocked");assert.ok(f.db.status()[0].bytes>0);
      assert.equal(calls,mode==="expired"?0:1);
    }finally{f.cleanup();}
  }
});
test("two instances cannot concurrently lease one job; ACK replay is accepted",async()=>{
  const f=fixture();f.db.enqueue(batch());const second=new TelemetrySpool(f.directory,producer);
  let release;const hold=new Promise(resolve=>release=resolve);let entered;const ready=new Promise(resolve=>entered=resolve);
  try {
    const first=f.db.deliver(secret,async request=>{entered();await hold;return ack(request,200);});
    await ready; assert.equal(await second.deliver(secret,async()=>{throw new Error("must not send");}),"idle");
    release();assert.equal(await first,"delivered");
  }finally{second.close();f.cleanup();}
});
test("candidate contract cannot use the production transport",async()=>{
  const f=fixture();f.db.enqueue(batch());
  try{await assert.rejects(f.db.sendOne(secret),/candidate_contract/);assert.equal(f.db.status()[0].state,"pending");}
  finally{f.cleanup();}
});
test("lost ACK retries the identical batch and accepts receiver replay receipt",async()=>{
  let now=baseNow;const f=fixture({now:()=>now});f.db.enqueue(batch(now));let saved;let calls=0;
  try{
    const transport=async request=>{
      calls++;const body=await request.clone().text();
      if(!saved){saved=body;await ack(request);throw new Error("ACK connection lost after commit");}
      assert.equal(body,saved);return ack(request,200);
    };
    assert.equal(await f.db.deliver(secret,transport),"pending");now+=60_000;
    assert.equal(await f.db.deliver(secret,transport),"delivered");assert.equal(calls,2);
  }finally{f.cleanup();}
});
test("expired lease is reclaimed, and old worker cannot overwrite new ACK",async()=>{
  let now=baseNow;const f=fixture({now:()=>now});f.db.enqueue(batch(now));const second=new TelemetrySpool(f.directory,producer,{now:()=>now});
  let release,entered;const hold=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
  try{
    const old=f.db.deliver(secret,async request=>{entered();await hold;return ack(request);});await ready;now+=31_000;
    assert.equal(await second.deliver(secret,request=>ack(request,200)),"delivered");
    release();assert.equal(await old,"lease_lost");assert.equal(f.db.status()[0].state,"delivered");
  }finally{second.close();f.cleanup();}
});
test("four OS processes enqueue one immutable batch once through the real CLI",async()=>{
  const f=fixture();const root=fileURLToPath(new URL("../",import.meta.url));const input=join(f.directory,"fixture.json");writeFileSync(input,batch());
  const exec=promisify(execFile);
  try{
    const args=["--import",pathToFileURL(join(root,"apps/web/node_modules/tsx/dist/loader.mjs")).href,
      join(root,"apps/telemetry-sender/cli.ts"),"enqueue",f.directory,producer,input];
    const results=await Promise.all(Array.from({length:4},()=>exec(process.execPath,args)));
    assert.equal(results.filter(r=>r.stdout.trim()==="queued").length,1);
    assert.equal(results.filter(r=>r.stdout.trim()==="duplicate").length,3);
    assert.equal(f.db.status()[0].batches,1);
  }finally{f.cleanup();}
});
test("byte capacity and schema checks cannot evict or partially enqueue a batch",()=>{
  const f=fixture({maxBytes:65536});let full=false;
  try{
    for(let i=0;i<80;i++){
      const value=JSON.parse(batch());value.events[0].message="x".repeat(1000);
      try{f.db.enqueue(Buffer.from(JSON.stringify(value)));}catch(error){assert.match(error.message,/spool_full/);full=true;break;}
    }
    assert.equal(full,true);const previous=f.db.status()[0];assert.ok(previous.bytes<=65536);
    const invalid=JSON.parse(batch());invalid.events[0].unexpectedSecret="invalid";
    assert.throws(()=>f.db.enqueue(Buffer.from(JSON.stringify(invalid))));
    assert.deepEqual(f.db.status()[0],previous);
  }finally{f.cleanup();}
});
