import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, renameSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { TelemetrySpool } from "../apps/telemetry-sender/spool.ts";
import { captureFileOnce } from "../apps/telemetry-sender/file-capture.ts";

const producer="fixture-producer";
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
