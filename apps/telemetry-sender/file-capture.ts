import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { TelemetrySpool, SpoolError } from "./spool";
import { parseTelemetryBatch, type TelemetryEvent, type TelemetrySource } from "../web/lib/telemetry-core";
import { redactConsoleLogMessage } from "../web/lib/log-report";

export type FileSource = { path: string; source: TelemetrySource };
export type SealedRotation = { path: string; bytes: number; sha256: string };
type Cursor = { device: string; inode: string; offset: number; anchor: string;
  handoff?: { device: string; inode: string; seal: string } };
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Only explicitly registered, projected JSONL files. Never infer actor/IP/attacks. */
export function captureFileOnce(spool: TelemetrySpool, config: FileSource, now = Date.now()) {
  return capture(spool,config,now);
}

/** The trusted projector/operator must close the old writer before sealing it. */
export function captureSealedRotationOnce(spool: TelemetrySpool, config: FileSource, seal: SealedRotation, now = Date.now()) {
  return capture(spool,config,now,seal);
}

function capture(spool: TelemetrySpool, config: FileSource, now: number, seal?: SealedRotation) {
  if (Object.keys(config).sort().join(",")!=="path,source" || !isAbsolute(config.path) || !config.source || !["application","container","systemd"].includes(config.source.type)) throw new SpoolError("invalid_file_source");
  let metadata = lstatSync(config.path,{bigint:true});
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) throw new SpoolError("unsafe_log_file");
  let path = realpathSync(config.path);
  const activePath=path, activeMetadata=metadata;
  const source = JSON.parse(JSON.stringify(config.source)) as TelemetrySource;
  // Full pinned Schema validates identifiers and extra fields even for an empty file.
  const sample: TelemetryEvent = { eventId: randomUUID(), observedAt: new Date(now).toISOString(), source,
    kind: "log", level: "info", outcome: "observed", message: "validation" };
  parseTelemetryBatch(Buffer.from(JSON.stringify({schemaVersion:1,producerId:spool.producerId,batchId:randomUUID(),events:[sample]})),now);
  const ordered = Object.fromEntries(Object.entries(source).sort(([a],[b])=>a.localeCompare(b)));
  const binding = hash(JSON.stringify({path,source:ordered}));
  let expected = spool.fileCursor(source.sourceId,binding);
  let previous = expected ? JSON.parse(expected) as Cursor : null;
  if(seal){
    if(Object.keys(seal).sort().join(",")!=="bytes,path,sha256" || !isAbsolute(seal.path) || !Number.isSafeInteger(seal.bytes) ||
      seal.bytes<0 || seal.bytes>1024*1024 || !/^[a-f0-9]{64}$/.test(seal.sha256))throw new SpoolError("invalid_rotation_seal");
    if(!previous)throw new SpoolError("rotation_without_checkpoint");
    if(previous.handoff && (previous.handoff.device!==metadata.dev.toString() || previous.handoff.inode!==metadata.ino.toString() ||
      previous.handoff.seal!==hash(JSON.stringify(seal))))throw new SpoolError("active_generation_changed");
    if(previous.device===metadata.dev.toString() && previous.inode===metadata.ino.toString())return {state:"rotation_already_completed",events:0};
    metadata=lstatSync(seal.path,{bigint:true});
    if(!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink!==1n)throw new SpoolError("unsafe_log_file");
    path=realpathSync(seal.path);
    if(path===activePath)throw new SpoolError("invalid_rotation_seal");
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd,{bigint:true});
    if (!stat.isFile() || stat.nlink !== 1n || stat.ino.toString() !== String(metadata.ino) || stat.dev.toString() !== String(metadata.dev)) throw new SpoolError("log_file_changed");
    const device=stat.dev.toString(),inode=stat.ino.toString(),offset=previous?.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset<0 || (previous && (previous.device!==device || previous.inode!==inode))) throw new SpoolError("rotation_requires_drain");
    if (BigInt(offset)>stat.size || (previous && anchor(fd,offset)!==previous.anchor)) throw new SpoolError("log_truncated_or_rewritten");
    if(seal){
      verifySeal(fd,seal);
      if(!previous!.handoff){
        const pinned: Cursor={...previous!,handoff:{device:activeMetadata.dev.toString(),inode:activeMetadata.ino.toString(),seal:hash(JSON.stringify(seal))}};
        const serialized=JSON.stringify(pinned);
        spool.commitFileCapture(source.sourceId,binding,expected,serialized);
        previous=pinned;expected=serialized;
      }
    }
    const buffer=Buffer.alloc(65536);const count=readSync(fd,buffer,0,buffer.length,offset);
    const events: TelemetryEvent[]=[];let consumed=0;
    while(events.length<5){
      const end=buffer.subarray(0,count).indexOf(10,consumed);
      if(end<0){if(count-consumed>8192)throw new SpoolError("line_too_large");break;}
      if(end-consumed>8192)throw new SpoolError("line_too_large");
      let line: Record<string,unknown>;
      try{line=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer.subarray(consumed,end)));}
      catch{throw new SpoolError("invalid_projected_log");}
      if(!line || Array.isArray(line) || typeof line!=="object" || Object.keys(line).sort().join(",")!=="level,message,observedAt" ||
        typeof line.message!=="string" || typeof line.observedAt!=="string" || typeof line.level!=="string") throw new SpoolError("invalid_projected_log");
      events.push({...sample,eventId:randomUUID(),observedAt:line.observedAt,level:line.level,
        message:redactConsoleLogMessage(line.message)||"[REDACTED]"});
      consumed=end+1;
    }
    // Recheck the captured prefix before committing. File writers must be append-only.
    const verify=Buffer.alloc(consumed);const verified=readSync(fd,verify,0,consumed,offset);
    if(verified!==consumed || !verify.equals(buffer.subarray(0,consumed)))throw new SpoolError("log_file_changed");
    const after=fstatSync(fd,{bigint:true});const current=lstatSync(path,{bigint:true});
    if(current.isSymbolicLink() || current.ino!==stat.ino || current.dev!==stat.dev || after.size<BigInt(offset+consumed))throw new SpoolError("rotation_requires_drain");
    const next: Cursor={device,inode,offset:offset+consumed,anchor:anchor(fd,offset+consumed),...(previous?.handoff?{handoff:previous.handoff}:{})};
    if(!events.length){
      if(seal){
        if(count!==0)throw new SpoolError("sealed_partial_line");
        verifySeal(fd,seal);
        const activeNow=lstatSync(activePath,{bigint:true});
        if(!activeNow.isFile() || activeNow.isSymbolicLink() || activeNow.nlink!==1n || activeNow.ino!==activeMetadata.ino || activeNow.dev!==activeMetadata.dev)throw new SpoolError("active_file_changed");
        const handoff: Cursor={device:activeNow.dev.toString(),inode:activeNow.ino.toString(),offset:0,anchor:hash(Buffer.alloc(0))};
        spool.commitFileCapture(source.sourceId,binding,expected,JSON.stringify(handoff));
        return {state:"rotated",events:0};
      }
      if(expected===null)spool.commitFileCapture(source.sourceId,binding,null,JSON.stringify(next));
      return {state:"idle",events:0};
    }
    const raw=Buffer.from(JSON.stringify({schemaVersion:1,producerId:spool.producerId,batchId:randomUUID(),events}));
    if(seal)verifySeal(fd,seal);
    spool.commitFileCapture(source.sourceId,binding,expected,JSON.stringify(next),raw);
    return {state:"queued",events:events.length};
  } finally {closeSync(fd);}
}

function verifySeal(fd:number,seal:SealedRotation){
  if(fstatSync(fd,{bigint:true}).size!==BigInt(seal.bytes))throw new SpoolError("sealed_file_changed");
  const digest=createHash("sha256"),chunk=Buffer.alloc(65536);let offset=0;
  while(offset<seal.bytes){
    const count=readSync(fd,chunk,0,Math.min(chunk.length,seal.bytes-offset),offset);
    if(!count)throw new SpoolError("sealed_file_changed");
    digest.update(chunk.subarray(0,count));offset+=count;
  }
  if(digest.digest("hex")!==seal.sha256 || fstatSync(fd,{bigint:true}).size!==BigInt(seal.bytes))throw new SpoolError("sealed_file_changed");
}

function anchor(fd:number,offset:number){
  const size=Math.min(64,offset),buffer=Buffer.alloc(size);
  if(readSync(fd,buffer,0,size,offset-size)!==size)throw new SpoolError("log_file_changed");
  return hash(buffer);
}
