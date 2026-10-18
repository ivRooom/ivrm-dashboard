import { openSync, readSync, closeSync } from "node:fs";
import { TelemetrySpool } from "./spool";
import { captureFileOnce, captureSealedRotationOnce, type FileSource } from "./file-capture";

function main() {
  const [command,directory,producer,input,...extra] = process.argv.slice(2);
  if (!["enqueue","capture-once","drain-once","status","send-once"].includes(command) || !directory || !producer || extra.length ||
      (["enqueue","capture-once","drain-once"].includes(command) ? !input : input !== undefined)) throw new Error("invalid_arguments");
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
