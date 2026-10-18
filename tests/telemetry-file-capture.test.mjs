import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, renameSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { TelemetrySpool } from "../apps/telemetry-sender/spool.ts";
import { captureFileOnce, captureSealedRotationOnce } from "../apps/telemetry-sender/file-capture.ts";

const producer="fixture-producer";
test("Docker JSON export keeps nanosecond event time and stream without inventing severity or actor",async()=>{
  const f=fixture();try{
    f.config.format="docker-json-export";f.config.source.type="container";f.config.source.resourceId="fixture-container";
    const time=new Date().toISOString().replace("Z","000001Z");
    writeFileSync(f.log,JSON.stringify({log:"Bearer fixture-secret peer=192.0.2.4\n",stream:"stderr",time})+"\n");
    captureFileOnce(f.spool,f.config);assert.equal(captureFileOnce(f.spool,f.config).state,"idle");
    const events=await messages(f.spool);assert.equal(events[0].observedAt,time);assert.equal(events[0].level,"info");
    assert.equal(events[0].outcome,"observed");assert.match(events[0].message,/^\[stderr\].*REDACTED/);
    assert.ok(!events[0].actor && !events[0].clientIp);
    assert.equal(readFileSync(join(f.queue,"telemetry.sqlite")).includes(Buffer.from("fixture-secret")),false);
  }finally{f.close();}
});
test("Docker exports reject unknown fields, forged streams and missing registered container identity",()=>{
  for(const extra of [{attrs:{env:"secret"}},{stream:"other"},{time:"2000-01-01T00:00:00Z"}]){
    const f=fixture();try{
      f.config.format="docker-json-export";f.config.source.type="container";f.config.source.resourceId="fixture-container";
      writeFileSync(f.log,JSON.stringify({log:"hello",stream:"stdout",time:new Date().toISOString(),...extra})+"\n");
      assert.throws(()=>captureFileOnce(f.spool,f.config));assert.equal(f.spool.status().length,0);
    }finally{f.close();}
  }
  const f=fixture();try{f.config.format="docker-json-export";assert.throws(()=>captureFileOnce(f.spool,f.config),/invalid_container_source/);}finally{f.close();}
});
test("source format cannot be changed behind an existing checkpoint",()=>{
  const f=fixture();try{
    f.config.source.type="container";f.config.source.resourceId="fixture-container";
    writeFileSync(f.log,line());captureFileOnce(f.spool,f.config);
    f.config.format="docker-json-export";assert.throws(()=>captureFileOnce(f.spool,f.config),/source_configuration_changed/);
  }finally{f.close();}
});
test("second rotation between drain passes cannot skip the pinned intermediate generation after restart",()=>{
  const f=fixture();let reopened;
  try{
    writeFileSync(f.log,Array.from({length:12},(_,i)=>line(`old ${i}`)).join(""));captureFileOnce(f.spool,f.config);
    renameSync(f.log,f.log+".1");writeFileSync(f.log,line("intermediate evidence"));const seal=sealFor(f.log+".1");
    captureSealedRotationOnce(f.spool,f.config,seal);
    f.spool.close();reopened=new TelemetrySpool(f.queue,producer);
    renameSync(f.log,f.log+".2");writeFileSync(f.log,line("newest"));
    assert.throws(()=>captureSealedRotationOnce(reopened,f.config,seal),/active_generation_changed/);
    assert.throws(()=>captureFileOnce(reopened,f.config),/rotation_requires_drain/);
    assert.equal(reopened.status()[0].batches,2);
  }finally{if(reopened)reopened.close();else f.spool.close();rmSync(f.directory,{recursive:true});}
});
const sealFor=path=>{const raw=readFileSync(path);return {path,bytes:raw.length,sha256:createHash("sha256").update(raw).digest("hex")};};
test("sealed rename rotation drains all old batches before atomically switching to active",async()=>{
  const f=fixture();try{
    const observedAt=new Date().toISOString();
    writeFileSync(f.log,Array.from({length:12},(_,i)=>line(`old ${i}`,{observedAt})).join(""));
    captureFileOnce(f.spool,f.config);renameSync(f.log,f.log+".1");writeFileSync(f.log,line("new"));const seal=sealFor(f.log+".1");
    assert.equal(captureSealedRotationOnce(f.spool,f.config,seal).events,5);
    assert.equal(captureSealedRotationOnce(f.spool,f.config,seal).events,2);
    assert.equal(captureSealedRotationOnce(f.spool,f.config,seal).state,"rotated");
    assert.equal(captureSealedRotationOnce(f.spool,f.config,seal).state,"rotation_already_completed");
    assert.equal(captureFileOnce(f.spool,f.config).events,1);
    assert.deepEqual((await messages(f.spool)).map(e=>e.message),[...Array.from({length:12},(_,i)=>`old ${i}`),"new"]);
  }finally{f.close();}
});
test("changed seal, wrong file identity and unterminated sealed tail cannot trigger handoff",()=>{
  for(const mode of ["hash","size","inode","growth","partial"]){
    const f=fixture();try{
      writeFileSync(f.log,mode==="partial"?line("unfinished").trimEnd():line());captureFileOnce(f.spool,f.config);
      renameSync(f.log,f.log+".1");writeFileSync(f.log,line("new"));let seal=sealFor(f.log+".1");
      if(mode==="hash")seal.sha256="0".repeat(64);
      if(mode==="size")seal.bytes++;
      if(mode==="inode"){const wrong=f.log+".wrong";writeFileSync(wrong,line());seal=sealFor(wrong);}
      if(mode==="growth")appendFileSync(seal.path,line("late write"));
      assert.throws(()=>captureSealedRotationOnce(f.spool,f.config,seal),/sealed_file_changed|rotation_requires_drain|sealed_partial_line/);
      assert.throws(()=>captureFileOnce(f.spool,f.config),/rotation_requires_drain/);
    }finally{f.close();}
  }
});
test("full queue cannot move the cursor past unread sealed evidence",()=>{
  const f=fixture({maxRows:1});try{
    writeFileSync(f.log,line("first"));captureFileOnce(f.spool,f.config);appendFileSync(f.log,line("unread"));
    renameSync(f.log,f.log+".1");writeFileSync(f.log,line("new"));const seal=sealFor(f.log+".1");
    assert.throws(()=>captureSealedRotationOnce(f.spool,f.config,seal),/spool_full/);
    assert.throws(()=>captureFileOnce(f.spool,f.config),/rotation_requires_drain/);
  }finally{f.close();}
});
test("handoff checkpoint failure preserves old identity and can be retried",()=>{
  const f=fixture();try{
    writeFileSync(f.log,line());captureFileOnce(f.spool,f.config);renameSync(f.log,f.log+".1");writeFileSync(f.log,line("new"));const seal=sealFor(f.log+".1");
    const db=new DatabaseSync(join(f.queue,"telemetry.sqlite"));db.exec("CREATE TRIGGER fixture_handoff BEFORE UPDATE ON file_cursors BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    try{
      assert.throws(()=>captureSealedRotationOnce(f.spool,f.config,seal));assert.throws(()=>captureFileOnce(f.spool,f.config),/rotation_requires_drain/);
      db.exec("DROP TRIGGER fixture_handoff");assert.equal(captureSealedRotationOnce(f.spool,f.config,seal).state,"rotated");
    }finally{db.close();}
  }finally{f.close();}
});
test("initial partial or empty file pins identity before idle and detects later rotation",()=>{
  for(const initial of ["",line("unfinished").trimEnd()]){
    const f=fixture();try{
      writeFileSync(f.log,initial);assert.equal(captureFileOnce(f.spool,f.config).state,"idle");
      renameSync(f.log,f.log+".1");writeFileSync(f.log,line("replacement"));
      assert.throws(()=>captureFileOnce(f.spool,f.config),/rotation_requires_drain/);
      assert.equal(f.spool.status().length,0);
    }finally{f.close();}
  }
});
function fixture(options={}){
  const directory=mkdtempSync(join(tmpdir(),"ivrm-file-capture-"));
  const log=join(directory,"projected.jsonl"),queue=join(directory,"queue");writeFileSync(log,"");
  const spool=new TelemetrySpool(queue,producer,options);
  const config={path:log,source:{sourceId:"fixture-log",serviceId:"fixture",type:"application",provider:"other",hostId:"fixture-host"}};
  return {directory,log,queue,spool,config,close(){spool.close();rmSync(directory,{recursive:true});}};
}
const line=(message="hello",more={})=>JSON.stringify({observedAt:new Date().toISOString(),level:"info",message,...more})+"\n";
async function messages(spool){
  const output=[];
  while(true){
    const result=await spool.deliver("a".repeat(64),async request=>{
      const batch=await request.json();output.push(...batch.events);
      return Response.json({accepted:true,batchId:batch.batchId,replayed:false,acceptedEvents:batch.events.length,duplicateEvents:0},{status:202});
    });
    if(result==="idle")return output;
    assert.equal(result,"delivered");
  }
}
test("capture masks before durable storage and resumes after restart without duplicates",async()=>{
  const f=fixture();writeFileSync(f.log,line("Bearer fixture-secret password=top-secret peer=192.0.2.3"));
  let reopened;
  try{
    assert.deepEqual(captureFileOnce(f.spool,f.config),{state:"queued",events:1});
    const storage=readFileSync(join(f.queue,"telemetry.sqlite"));
    assert.equal(storage.includes(Buffer.from("top-secret")),false);assert.equal(storage.includes(Buffer.from("fixture-secret")),false);
    f.spool.close();reopened=new TelemetrySpool(f.queue,producer);
    assert.deepEqual(captureFileOnce(reopened,f.config),{state:"idle",events:0});
    appendFileSync(f.log,line("new message"));captureFileOnce(reopened,f.config);
    const events=await messages(reopened);assert.equal(events.length,2);assert.match(events[0].message,/REDACTED/);
    assert.ok(!events[0].clientIp && !events[0].actor);assert.equal(events[0].outcome,"observed");
  }finally{if(reopened)reopened.close();else f.spool.close();rmSync(f.directory,{recursive:true});}
});
test("partial trailing line waits for newline; each pass captures at most five entries",async()=>{
  const f=fixture();try{
    const partial=line("partial").trimEnd();writeFileSync(f.log,partial);
    assert.equal(captureFileOnce(f.spool,f.config).state,"idle");
    appendFileSync(f.log,"\n"+Array.from({length:6},(_,i)=>line(`line ${i}`)).join(""));
    assert.equal(captureFileOnce(f.spool,f.config).events,5);assert.equal(captureFileOnce(f.spool,f.config).events,2);
    assert.equal((await messages(f.spool)).length,7);
  }finally{f.close();}
});
test("malformed, oversized, stale and untrusted extra fields never advance the checkpoint",()=>{
  for(const raw of ["not JSON\n","x".repeat(8193),line("secret",{actor:{type:"human"}}),JSON.stringify({observedAt:"2000-01-01T00:00:00Z",level:"info",message:"old"})+"\n"]){
    const f=fixture();try{
      writeFileSync(f.log,line("valid prefix")+raw);assert.throws(()=>captureFileOnce(f.spool,f.config));assert.equal(f.spool.status().length,0);
      writeFileSync(f.log,line("replacement"));assert.equal(captureFileOnce(f.spool,f.config).events,1);
    }finally{f.close();}
  }
});
test("full spool rejects capture without advancing cursor; evidence remains in source",async()=>{
  const f=fixture({maxRows:1});try{
    writeFileSync(f.log,line("first"));captureFileOnce(f.spool,f.config);appendFileSync(f.log,line("second"));
    assert.throws(()=>captureFileOnce(f.spool,f.config),/spool_full/);
    const db=new DatabaseSync(join(f.queue,"telemetry.sqlite"));
    const cursor=JSON.parse(db.prepare("SELECT cursor FROM file_cursors").get().cursor);db.close();
    assert.equal(cursor.offset,Buffer.byteLength(readFileSync(f.log,"utf8").split("\n")[0]+"\n"));
    assert.equal((await messages(f.spool)).length,1); // Sent tombstone still consumes row quota.
    assert.throws(()=>captureFileOnce(f.spool,f.config),/spool_full/);
  }finally{f.close();}
});
test("failure while saving checkpoint rolls back the newly enqueued batch",()=>{
  const f=fixture();try{
    writeFileSync(f.log,line());const db=new DatabaseSync(join(f.queue,"telemetry.sqlite"));
    db.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON file_cursors BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    assert.throws(()=>captureFileOnce(f.spool,f.config));assert.equal(f.spool.status().length,0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM file_cursors").get().n,0);
    db.exec("DROP TRIGGER fixture_fail");db.close();assert.equal(captureFileOnce(f.spool,f.config).events,1);
  }finally{f.close();}
});
test("rotation, truncation, rewritten prefix and source changes fail closed",()=>{
  for(const mode of ["rotation","truncation","rewrite","source"]){
    const f=fixture();try{
      writeFileSync(f.log,line("original line"));captureFileOnce(f.spool,f.config);
      if(mode==="rotation"){renameSync(f.log,f.log+".1");writeFileSync(f.log,line());}
      if(mode==="truncation")writeFileSync(f.log,"");
      if(mode==="rewrite")writeFileSync(f.log,line("replacement much longer line"));
      if(mode==="source")f.config.source.serviceId="different-service";
      assert.throws(()=>captureFileOnce(f.spool,f.config),/rotation_requires_drain|log_truncated_or_rewritten|source_configuration_changed/);
      assert.equal(f.spool.status()[0].batches,1);
    }finally{f.close();}
  }
});
test("four collector processes never commit a duplicate batch or advance past unqueued data",async()=>{
  const f=fixture();const root=fileURLToPath(new URL("../",import.meta.url));const configPath=join(f.directory,"source.json");
  writeFileSync(f.log,line("concurrent capture"));writeFileSync(configPath,JSON.stringify(f.config));
  const args=["--import",pathToFileURL(join(root,"apps/web/node_modules/tsx/dist/loader.mjs")).href,
    join(root,"apps/telemetry-sender/cli.ts"),"capture-once",f.queue,producer,configPath];
  try{
    const execute=promisify(execFile);
    const results=await Promise.allSettled(Array.from({length:4},()=>execute(process.execPath,args)));
    assert.equal(results.filter(r=>r.status==="fulfilled" && JSON.parse(r.value.stdout).state==="queued").length,1);
    for(const result of results)if(result.status==="rejected"){
      assert.equal(result.reason.code,1);assert.match(result.reason.stderr,/telemetry_sender_failed/);
    }
    assert.equal(f.spool.status()[0].batches,1);
    assert.equal((await messages(f.spool)).length,1);
    assert.equal(captureFileOnce(f.spool,f.config).state,"idle");
  }finally{f.close();}
});
