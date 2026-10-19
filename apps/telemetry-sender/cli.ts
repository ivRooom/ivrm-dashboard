import { openSync, readSync, closeSync } from "node:fs";
import { TelemetrySpool } from "./spool";
import { readSpoolHealth } from "./health";
import { captureFileOnce, captureSealedRotationOnce, type FileSource } from "./file-capture";

function main() {
  const [command,directory,producer,input,...extra] = process.argv.slice(2);
  if (!["enqueue","capture-once","drain-once","status","health","health-sources","send-once"].includes(command) || !directory || !producer || extra.length ||
      (["enqueue","capture-once","drain-once","health-sources"].includes(command) ? !input : input !== undefined)) throw new Error("invalid_arguments");
  if (command === "health" || command === "health-sources") {
    let expected: string[] | undefined;
    if (command === "health-sources") {
      const fd = openSync(input!,"r"), buffer = Buffer.alloc(8193); let length = 0;
      try { while (length < buffer.length) { const n = readSync(fd,buffer,length,buffer.length-length,null); if (!n) break; length += n; } }
      finally { closeSync(fd); }
      if (length > 8192) throw new Error("invalid_configuration");
      const config = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer.subarray(0,length)));
      if (!config || Object.keys(config).join(",") !== "expectedSourceIds" || !Array.isArray(config.expectedSourceIds)) throw new Error("invalid_configuration");
      expected = config.expectedSourceIds;
    }
    const health = readSpoolHealth(directory, producer, Date.now(), expected);
    console.log(JSON.stringify(health));
    if (health.status === "attention") process.exitCode = 2;
    return;
  }
  const spool = new TelemetrySpool(directory,producer);
  return (async()=>{
    try {
      if(command === "enqueue" || command === "capture-once" || command === "drain-once") {
        const descriptor = openSync(input!,"r"); const buffer = Buffer.alloc(65537); let length=0;
        try { while(length<buffer.length) { const size=readSync(descriptor,buffer,length,buffer.length-length,null); if(!size)break;length+=size; } }
        finally {closeSync(descriptor);}
        if(command === "enqueue")console.log(spool.enqueue(buffer.subarray(0,length)));
        else {
          if(length>8192)throw new Error("invalid_configuration");
          const config=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer.subarray(0,length)));
          if(command === "drain-once"){
            if(Object.keys(config).sort().join(",")!=="config,seal")throw new Error("invalid_configuration");
            console.log(JSON.stringify(captureSealedRotationOnce(spool,config.config,config.seal)));
          }else console.log(JSON.stringify(captureFileOnce(spool,config as FileSource)));
        }
      } else if(command === "status") console.log(JSON.stringify(spool.status()));
      else console.log(await spool.sendOne(process.env.IVRM_TELEMETRY_PRODUCER_SECRET ?? ""));
    } finally {spool.close();}
  })();
}
// No payloads, filenames, credentials or backend diagnostics on failure.
Promise.resolve().then(main).catch(()=>{ console.error("telemetry_sender_failed"); process.exitCode=1; });
