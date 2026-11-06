/** Streaming migration runs entirely off the serving thread; only its owner publishes. */
import { createHash, type Hash } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, openSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import { exactFileIdentity, usageLogIdentityKey, usageLogRevisionKey,
  type UsageLogRevision } from "./log";
import { parseCompactionLine } from "./compaction-record";
import { USAGE_DETAIL_RETENTION_MS } from "./retention-contract";
import { UsageRollupBuilder, parseUsageRollupRecord } from "./rollup";
import { applyUserCostOverlaySnapshot } from "./user-cost-overlays";
import type { UsageCompactionWorkerInput, UsageCompactionWorkerReply, UsageCompactionProgress } from "./compaction";

const CHUNK_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_CATCH_UP_BYTES = 16 * 1024 * 1024;

declare const self: Worker;
let job: CompactionJob | null = null;
class SourceChangedError extends Error {}

function revision(path: string, fd: number): UsageLogRevision {
  const info = fstatSync(fd);
  if (!info.isFile()) throw new SourceChangedError("not a regular usage ledger");
  return { path, ...exactFileIdentity(fd), birthtimeMs: info.birthtimeMs,
    size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}
function writeAll(fd: number, bytes: Uint8Array): void {
  for (let offset = 0; offset < bytes.byteLength;) {
    const wrote = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (wrote <= 0) throw new Error("usage compaction write stalled");
    offset += wrote;
  }
}
function progress(phase: UsageCompactionProgress["phase"], processedBytes: number, totalBytes: number): void {
  self.postMessage({ kind: "progress", phase, processedBytes, totalBytes });
}
function digestPrefix(fd: number, size: number): string {
  const hash = createHash("sha256");
  const scratch = Buffer.allocUnsafe(CHUNK_BYTES);
  progress("verify", 0, size);
  for (let offset = 0; offset < size;) {
    const count = readSync(fd, scratch, 0, Math.min(scratch.byteLength, size - offset), offset);
    if (count <= 0) throw new SourceChangedError("usage ledger shrank");
    hash.update(scratch.subarray(0, count));
    offset += count;
    if (offset % (32 * CHUNK_BYTES) === 0 || offset === size) progress("verify", offset, size);
  }
  return hash.digest("hex");
}

class CompactionJob {
  builder: UsageRollupBuilder | undefined;
  readonly cutoff: number;
  readonly buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  readonly line = Buffer.allocUnsafe(MAX_LINE_BYTES);
  hash: Hash = createHash("sha256");
  lineLength = 0;
  consumed = 0;
  expired = 0;
  identity = "";
  rawFd: number | undefined;
  constructor(readonly input: UsageCompactionWorkerInput) {
    this.cutoff = input.now - USAGE_DETAIL_RETENTION_MS;
    if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error("invalid compaction time");
    applyUserCostOverlaySnapshot(input.prices);
  }
  consume(fd: number, end: number): void {
    progress("scan", this.consumed, end);
    while (this.consumed < end) {
      const count = readSync(fd, this.buffer, 0, Math.min(this.buffer.byteLength, end - this.consumed), this.consumed);
      if (count <= 0) throw new SourceChangedError("usage ledger shrank");
      this.hash.update(this.buffer.subarray(0, count));
      let start = 0;
      while (start < count) {
        const newline = this.buffer.indexOf(0x0a, start);
        const stop = newline >= 0 && newline < count ? newline + 1 : count;
        const length = stop - start;
        if (this.lineLength + length > MAX_LINE_BYTES) throw new Error("oversized usage line");
        this.buffer.copy(this.line, this.lineLength, start, stop);
        this.lineLength += length;
        if (newline >= 0 && newline < count) {
          const bytes = this.line.subarray(0, this.lineLength);
          const { entry, rollup } = parseCompactionLine(bytes);
          if ((rollup || entry) && !this.builder) {
            this.builder = new UsageRollupBuilder({ timeZone: rollup?.timeZone ?? this.input.timeZone, compactedBefore: this.cutoff });
          }
          if (rollup) this.builder!.addRollup(rollup);
          else if (entry && entry.timestamp < this.cutoff) { this.builder!.add(entry); this.expired++; }
          else writeAll(this.rawFd!, bytes);
          this.lineLength = 0;
        }
        start = stop;
      }
      this.consumed += count;
      if (this.consumed % (32 * CHUNK_BYTES) === 0 || this.consumed === end) progress("scan", this.consumed, end);
    }
  }
  openSource(): number {
    const fd = openSync(this.input.path, "r");
    try {
      const captured = revision(this.input.path, fd);
      const linked = statSync(this.input.path, { bigint: true });
      if (linked.dev.toString() !== captured.dev || linked.ino.toString() !== captured.ino) {
        throw new SourceChangedError("usage ledger path replaced");
      }
      const identity = usageLogIdentityKey(captured);
      if (this.identity && this.identity !== identity) throw new SourceChangedError("usage ledger identity changed");
      this.identity = identity;
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  prepare(): UsageCompactionWorkerReply {
    let source: number | undefined;
    try {
      source = this.openSource();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "unchanged", currentBytes: 0 };
      throw error;
    }
    try {
      const captured = revision(this.input.path, source);
      this.rawFd = openSync(this.input.rawPath, "wx+", 0o600);
      this.consume(source, captured.size);
    } finally { closeSync(source); }
    return this.catchUp();
  }
  catchUp(): UsageCompactionWorkerReply {
    const source = this.openSource();
    let stable: UsageLogRevision;
    let boundaryDigest: string;
    try {
      const captured = revision(this.input.path, source);
      if (captured.size < this.consumed || captured.size - this.consumed > MAX_CATCH_UP_BYTES) {
        return { kind: "deferred", reason: captured.size < this.consumed ? "source-changed" : "catch-up-limit", currentBytes: captured.size };
      }
      // This checks every captured byte, not just a boundary: a rewrite followed by an append
      // must never be mistaken for append-only growth.
      if (digestPrefix(source, this.consumed) !== this.hash.copy().digest("hex")) {
        return { kind: "deferred", reason: "source-changed", currentBytes: captured.size };
      }
      this.consume(source, captured.size);
      const after = revision(this.input.path, source);
      if (usageLogRevisionKey(after) !== usageLogRevisionKey(captured)
        && (usageLogIdentityKey(after) !== usageLogIdentityKey(captured) || after.size <= captured.size)) {
        return { kind: "deferred", reason: "source-changed", currentBytes: after.size };
      }
      // An append during this pass leaves a valid candidate at captured EOF. The owner sees
      // its stale revision and asks this same worker to catch up again, bounded to four passes.
      stable = captured;
      const from = Math.max(0, stable.size - 64 * 1024);
      const boundary = Buffer.alloc(stable.size - from);
      let read = 0;
      while (read < boundary.byteLength) {
        const count = readSync(source, boundary, read, boundary.byteLength - read, from + read);
        if (count <= 0) throw new SourceChangedError("usage ledger shrank");
        read += count;
      }
      boundaryDigest = createHash("sha256").update(boundary).digest("hex");
    } finally { closeSync(source); }
    if (this.expired === 0) return { kind: "unchanged", currentBytes: stable.size };
    this.writeCandidate();
    return { kind: "prepared", revision: stable, currentBytes: statSync(this.input.targetPath).size,
      boundaryDigest, pendingBytes: this.lineLength, compactedBefore: this.cutoff };
  }
  writeCandidate(): void {
    try { unlinkSync(this.input.targetPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const target = openSync(this.input.targetPath, "wx", 0o600);
    try {
      // Rollups lead the ledger so readers can identify the migrated format with one small read.
      for (const rollup of this.builder!.finish()) {
        const serialized = JSON.stringify(rollup);
        // Validate exactly what readers will receive, including JSON's NaN/Infinity -> null
        // conversion, before permitting the owner to replace any raw evidence.
        if (!parseUsageRollupRecord(JSON.parse(serialized))) throw new Error("invalid generated usage rollup");
        const encoded = Buffer.from(`${serialized}\n`);
        if (encoded.byteLength > MAX_LINE_BYTES) throw new Error("oversized usage rollup");
        writeAll(target, encoded);
      }
      const rawSize = fstatSync(this.rawFd!).size;
      progress("write", 0, rawSize);
      for (let offset = 0; offset < rawSize;) {
        const count = readSync(this.rawFd!, this.buffer, 0, Math.min(this.buffer.byteLength, rawSize - offset), offset);
        if (count <= 0) throw new Error("usage compaction raw copy stalled");
        writeAll(target, this.buffer.subarray(0, count));
        offset += count;
        if (offset % (32 * CHUNK_BYTES) === 0 || offset === rawSize) progress("write", offset, rawSize);
      }
      // An incomplete suffix remains byte-for-byte at EOF and is never treated as a row.
      writeAll(target, this.line.subarray(0, this.lineLength));
      fsyncSync(target);
    } finally { closeSync(target); }
  }
  close(): void {
    if (this.rawFd !== undefined) { closeSync(this.rawFd); this.rawFd = undefined; }
  }
}

self.onmessage = (event: MessageEvent<{ type: string; input?: UsageCompactionWorkerInput }>) => {
  try {
    let result: UsageCompactionWorkerReply;
    if (event.data.type === "prepare" && event.data.input) {
      job?.close();
      job = new CompactionJob(event.data.input);
      result = job.prepare();
    } else if (event.data.type === "catch-up" && job) result = job.catchUp();
    else throw new Error("invalid compaction message");
    self.postMessage(result);
  } catch (error) {
    job?.close();
    const code = (error as NodeJS.ErrnoException | null)?.code;
    self.postMessage({ kind: "deferred", reason: error instanceof SourceChangedError ? "source-changed" : typeof code === "string" ? "worker-failed" : "invalid-record" } satisfies UsageCompactionWorkerReply);
  }
};
