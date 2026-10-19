import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { parseTelemetryBatch, verifyTelemetryReceipt, type TelemetryBatch } from "../web/lib/telemetry-core";
import pin from "../../contracts/ivrm/operational-telemetry.v1.pin.json";

const ENDPOINT = "https://console.ivrm.jp/api/agent/telemetry";
const MAX_AGE = 7 * 86400_000;
export class SpoolError extends Error {}
type Job = { id: string; raw: Uint8Array; attempts: number; token: string };
type Options = { maxRows?: number; maxBytes?: number; maxAttempts?: number; now?: () => number };

/** Private, bounded, durable transport only. No Docker/SSH/file collection. */
export class TelemetrySpool {
  private db: DatabaseSync;
  private now: () => number;
  private maxRows: number;
  private maxBytes: number;
  private maxAttempts: number;
  constructor(directory: string, readonly producerId: string, options: Options = {}) {
    if (!isAbsolute(directory) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(producerId)) throw new SpoolError("invalid_configuration");
    this.maxRows = options.maxRows ?? 10_000;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.maxAttempts = options.maxAttempts ?? 20;
    for (const [value, min, max] of [[this.maxRows, 1, 10000], [this.maxBytes, 65536, 67108864], [this.maxAttempts, 1, 100]]) {
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new SpoolError("invalid_configuration");
    }
    this.now = options.now ?? Date.now;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (process.platform !== "win32" && (dir.mode & 0o077))) throw new SpoolError("unsafe_directory");
    const file = join(directory, "telemetry.sqlite");
    try { closeSync(openSync(file, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new SpoolError("unsafe_database");
    chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      PRAGMA max_page_count=32768;
      CREATE TABLE IF NOT EXISTS metadata(producer TEXT PRIMARY KEY, configuration TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, digest TEXT NOT NULL, raw BLOB,
        events INTEGER NOT NULL, oldest REAL NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        due REAL NOT NULL DEFAULT 0, lease_until REAL NOT NULL DEFAULT 0, token TEXT, reason TEXT);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state,due,lease_until);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS file_cursors(source TEXT PRIMARY KEY, configuration TEXT NOT NULL, cursor TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS capture_checks(source TEXT PRIMARY KEY, checked_at INTEGER NOT NULL,
      last_success INTEGER, result TEXT NOT NULL);`);
    try {
      this.transaction(() => {
        const existing = this.db.prepare("SELECT producer,configuration FROM metadata").get();
        const configuration = JSON.stringify([this.maxRows,this.maxBytes,this.maxAttempts]);
        if (existing && existing.producer !== producerId) throw new SpoolError("producer_mismatch");
        if (existing && existing.configuration !== configuration) throw new SpoolError("configuration_mismatch");
        if (!existing) this.db.prepare("INSERT INTO metadata VALUES(?,?)").run(producerId,configuration);
      });
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  private transaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = callback(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  enqueue(raw: Uint8Array): "queued" | "duplicate" {
    return this.transaction(() => this.enqueueWithinTransaction(raw));
  }
  private enqueueWithinTransaction(raw: Uint8Array): "queued" | "duplicate" {
    const batch = parseTelemetryBatch(raw, this.now());
    if (batch.producerId !== this.producerId) throw new SpoolError("producer_mismatch");
    const id = batch.batchId.toLowerCase(), digest = createHash("sha256").update(raw).digest("hex");
      const existing = this.db.prepare("SELECT digest FROM jobs WHERE id=?").get(id);
      if (existing) {
        if (existing.digest !== digest) throw new SpoolError("content_conflict");
        return "duplicate";
      }
      const usage = this.db.prepare("SELECT count(*) AS rows, coalesce(sum(length(raw)),0) AS bytes FROM jobs").get()!;
      if (Number(usage.rows) >= this.maxRows || Number(usage.bytes) + raw.length > this.maxBytes) throw new SpoolError("spool_full");
      this.db.prepare("INSERT INTO jobs(id,digest,raw,events,oldest,state) VALUES(?,?,?,?,?,'pending')")
        .run(id, digest, raw, batch.events.length, Math.min(...batch.events.map(e => Date.parse(e.observedAt))));
      return "queued";
  }
  fileCursor(source: string, configuration: string): string | null {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(source) || !/^[a-f0-9]{64}$/.test(configuration)) throw new SpoolError("invalid_configuration");
    const row = this.db.prepare("SELECT configuration,cursor FROM file_cursors WHERE source=?").get(source);
    if (row && row.configuration !== configuration) throw new SpoolError("source_configuration_changed");
    return row ? String(row.cursor) : null;
  }
  commitFileCapture(source: string, configuration: string, expected: string | null, next: string, raw?: Uint8Array) {
    if (next.length > 1024) throw new SpoolError("invalid_cursor");
    return this.transaction(() => {
      if (this.fileCursor(source,configuration) !== expected) throw new SpoolError("cursor_changed");
      if (expected === null && Number(this.db.prepare("SELECT count(*) AS n FROM file_cursors").get()!.n) >= 64) throw new SpoolError("source_limit");
      const result = raw ? this.enqueueWithinTransaction(raw) : "checkpointed";
      this.db.prepare("INSERT INTO file_cursors VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor").run(source,configuration,next);
      return result;
    });
  }
  status() {
    return this.db.prepare("SELECT state,count(*) AS batches,coalesce(sum(length(raw)),0) AS bytes,min(oldest) AS oldest FROM jobs GROUP BY state ORDER BY state").all();
  }
  recordCaptureCheck(source: string, result: "checked" | "failed", at: number) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(source) || !["checked","failed"].includes(result) ||
        !Number.isSafeInteger(at) || at < 0) throw new SpoolError("invalid_configuration");
    // Only checkpointed sources: no arbitrary/unbounded source registration through diagnostics.
    this.db.prepare(`INSERT INTO capture_checks(source,checked_at,last_success,result)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM file_cursors WHERE source=?)
      ON CONFLICT(source) DO UPDATE SET checked_at=excluded.checked_at,result=excluded.result,
        last_success=CASE WHEN excluded.result='checked' THEN excluded.checked_at ELSE capture_checks.last_success END
      WHERE excluded.checked_at>=capture_checks.checked_at`)
      .run(source,at,result === "checked" ? at : null,result,source);
  }
  private claim(): Job | undefined {
    return this.transaction(() => {
      const now = this.now();
      // Expired evidence stays on disk for explicit operator handling.
      this.db.prepare("UPDATE jobs SET state='blocked',reason='event_expired',token=NULL WHERE state='pending' AND lease_until<=? AND oldest<?").run(now, now-MAX_AGE);
      this.db.prepare("UPDATE jobs SET state='blocked',reason='attempt_limit',token=NULL WHERE state='pending' AND lease_until<=? AND attempts>=?").run(now,this.maxAttempts);
      const row = this.db.prepare("SELECT id,raw,attempts FROM jobs WHERE state='pending' AND due<=? AND lease_until<=? ORDER BY oldest,rowid LIMIT 1").get(now, now);
      if (!row) return;
      const token = randomBytes(16).toString("hex");
      this.db.prepare("UPDATE jobs SET token=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(token, now+30_000, row.id!);
      return { id: String(row.id), raw: row.raw as Uint8Array, attempts: Number(row.attempts)+1, token };
    });
  }
  /** Candidate contract deliberately cannot reach a production endpoint. */
  async sendOne(secret: string): Promise<string> {
    if (String(pin.releaseState) !== "merged") throw new SpoolError("candidate_contract");
    return this.deliver(secret, request => fetch(request));
  }
  /** Injectable transport for isolated contract tests; not a CLI enable switch. */
  async deliver(secret: string, transport: (request: Request) => Promise<Response>): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new SpoolError("invalid_configuration");
    const job = this.claim();
    if (!job) return "idle";
    let state = "pending", reason = "transport_failed", delay = Math.min(3600, 2 ** Math.min(job.attempts, 12));
    try {
      const timestamp = String(Math.floor(this.now()/1000)), nonce = randomBytes(16).toString("hex");
      const signature = createHmac("sha256", secret)
        .update(`POST\n/api/agent/telemetry\n${this.producerId}\n${timestamp}\n${nonce}\n`).update(job.raw).digest("hex");
      const request = new Request(ENDPOINT, { method: "POST", body: Buffer.from(job.raw), redirect: "error",
        signal: AbortSignal.timeout(8_000), headers: { "Content-Type": "application/json", "X-IVRM-Producer-ID": this.producerId,
          "X-IVRM-Timestamp": timestamp, "X-IVRM-Nonce": nonce, "X-IVRM-Signature": signature } });
      const response = await transport(request);
      if (response.status === 200 || response.status === 202) {
        const bytes = await boundedResponse(response);
        const batch = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(job.raw)) as TelemetryBatch;
        const receipt = verifyTelemetryReceipt(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), batch);
        if (receipt.replayed !== (response.status === 200)) throw new SpoolError("invalid_ack");
        state = "delivered"; reason = "accepted";
      } else {
        // Never log or persist response bodies; they may include secrets/HTML.
        await response.body?.cancel();
        if ([400,401,403,409,413,415].includes(response.status)) { state = "blocked"; reason = "request_rejected"; }
        else if (response.status === 408 || response.status === 429 || response.status === 503) {
          reason = "receiver_unavailable";
          const retry = response.headers.get("Retry-After");
          const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry)-this.now())/1000 : 0;
          delay = Math.max(delay, Math.min(3600, Number.isFinite(seconds) ? Math.max(60,seconds) : 60));
        } else if (response.status !== 404 && response.status < 500) { state = "blocked"; reason = "unexpected_response"; }
      }
    } catch { /* Timeout, bad ACK or unknown delivery result: retain identical bytes. */ }
    if (state === "pending" && job.attempts >= this.maxAttempts) { state = "blocked"; reason = "attempt_limit"; }
    const jitter = Math.floor(Math.random()*Math.max(1, delay/4));
    const updated = this.db.prepare(`UPDATE jobs SET state=?,reason=?,due=?,lease_until=0,token=NULL,
      raw=CASE WHEN ?='delivered' THEN NULL ELSE raw END WHERE id=? AND token=?`)
      .run(state, reason, this.now()+(delay+jitter)*1000, state, job.id, job.token);
    return updated.changes ? state : "lease_lost";
  }
}

async function boundedResponse(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new SpoolError("invalid_ack");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      size += value.byteLength;
      if (size > 2048) throw new SpoolError("invalid_ack");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
}
