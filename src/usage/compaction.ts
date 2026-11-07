/** Owner-thread publication of a worker-prepared, digest-checked usage ledger. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertSpendLedgerOwnerHeld } from "../lib/spend-ledger-owner";
import { renameAtomicFile } from "../lib/windows-atomic-replace";
import { spawnWorker } from "../lib/worker-embed";
import { registerStorageWorker, terminateStorageWorker, withStorageWorkerSpawnGate } from "../storage/worker-lifecycle";
import { currentUsageLogRevision, exactFileIdentity, usageLogIdentityKey, usageLogPath, usageLogRevisionKey, type UsageLogRevision } from "./log";
import { parseCompactionLine } from "./compaction-record";
import { captureUserCostOverlaySnapshot, type UserCostOverlaySnapshot } from "./user-cost-overlays";

export type UsageCompactionPrices = UserCostOverlaySnapshot;
export type UsageCompactionDeferredReason = "invalid-record" | "source-changed" | "catch-up-limit"
  | "aborted" | "timeout" | "worker-failed" | "publication-failed";
export interface UsageCompactionProgress {
  phase: "scan" | "verify" | "write";
  processedBytes: number;
  totalBytes: number;
}
export type UsageCompactionResult = {
  kind: "unchanged" | "replaced" | "deferred";
  reason?: UsageCompactionDeferredReason;
  removedBytes?: number;
  currentBytes?: number;
};
export interface UsageCompactionOptions {
  now?: number;
  signal?: AbortSignal;
  onProgress?: (progress: UsageCompactionProgress) => void;
  /** Bounded race/failure injection for tests; never passed to the worker. */
  onPrepared?: () => void;
  beforePublish?: () => void;
}
export interface UsageCompactionWorkerInput {
  path: string;
  rawPath: string;
  targetPath: string;
  now: number;
  timeZone: string;
  prices: UsageCompactionPrices;
}
export type UsageCompactionWorkerReply =
  | { kind: "unchanged" | "deferred"; currentBytes?: number; reason?: UsageCompactionDeferredReason }
  | { kind: "prepared"; revision: UsageLogRevision; currentBytes: number; boundaryDigest: string; pendingBytes: number; compactedBefore: number };

/** A prepare is read-only with respect to the source ledger and needs no writer lease. */
export interface PreparedUsageCompaction {
  readonly path: string;
  readonly targetPath: string;
  readonly snapshot: UsageCompactionWorkerReply;
  catchUp(): Promise<UsageCompactionWorkerReply>;
  close(): Promise<void>;
}

let active: Promise<UsageCompactionResult> | null = null;
let activeAbort: AbortController | null = null;
const preparations = new Set<() => Promise<void>>();

function removeOwnedTemp(path: string): void {
  try { unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Remove only recognizable scratch files whose creating process is proven dead. */
export function cleanupAbandonedUsageCompactionFiles(): number {
  assertSpendLedgerOwnerHeld();
  if (active || preparations.size > 0) throw new Error("usage compaction is active");
  const home = dirname(usageLogPath());
  const filename = /^\.usage-compaction-([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:raw|new)$/;
  let removed = 0;
  for (const name of readdirSync(home)) {
    const match = filename.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid > 2_147_483_647 || pid === process.pid) continue;
    try { process.kill(pid, 0); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
    const path = join(home, name);
    try {
      // lstat rejects symlinks, directories and devices. Recheck before unlink to narrow a
      // non-cooperating path swap; the held owner excludes every cooperating compactor.
      const found = lstatSync(path, { bigint: true });
      if (!found.isFile()) continue;
      const current = lstatSync(path, { bigint: true });
      if (!current.isFile() || current.dev !== found.dev || current.ino !== found.ino) continue;
      unlinkSync(path);
      removed++;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return removed;
}

/** Launch exactly one bounded-memory worker; callers must always close the preparation. */
export async function prepareUsageLedgerCompaction(options: UsageCompactionOptions = {}): Promise<PreparedUsageCompaction> {
  if (preparations.size > 0) throw new Error("usage compaction worker is already running");
  const path = usageLogPath();
  const stem = join(dirname(path), `.usage-compaction-${process.pid}-${randomUUID()}`);
  const rawPath = `${stem}.raw`;
  const targetPath = `${stem}.new`;
  const worker = spawnWorker(new URL("./compaction-worker.ts", import.meta.url).href, "usage-compaction-worker");
  registerStorageWorker(worker);
  let pending: { resolve: (reply: UsageCompactionWorkerReply) => void; reject: (error: Error) => void } | null = null;
  let closed = false;
  let closing: Promise<void> | null = null;
  const reject = () => pending?.reject(Object.assign(new Error("usage compaction stopped"), { reason: "worker-failed" }));
  const abort = () => { reject(); void close(); };
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    options.signal?.removeEventListener("abort", abort);
    reject();
    closing = terminateStorageWorker(worker).finally(() => {
      try { removeOwnedTemp(rawPath); removeOwnedTemp(targetPath); }
      finally { preparations.delete(close); }
    });
    return closing;
  };
  preparations.add(close);
  worker.onmessage = (event: MessageEvent<UsageCompactionWorkerReply | (UsageCompactionProgress & { kind: "progress" })>) => {
    if (event.data.kind === "progress") {
      try { options.onProgress?.(event.data); } catch { /* observers cannot disrupt migration */ }
      return;
    }
    const receiver = pending;
    pending = null;
    receiver?.resolve(event.data);
  };
  worker.onerror = () => reject();
  worker.addEventListener("close", reject);
  options.signal?.addEventListener("abort", abort, { once: true });
  const request = async (message: unknown, timeoutMs = 120_000): Promise<UsageCompactionWorkerReply> => {
    if (closed || options.signal?.aborted) throw new Error("usage compaction stopped");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<UsageCompactionWorkerReply>((resolve, rejectPromise) => {
        pending = { resolve, reject: rejectPromise };
        timer = setTimeout(() => rejectPromise(Object.assign(new Error("usage compaction timed out"), { reason: "timeout" })), timeoutMs);
        worker.postMessage(message);
      });
    } finally { if (timer) clearTimeout(timer); }
  };
  try {
    const snapshot = await request({ type: "prepare", input: {
      path, rawPath, targetPath, now: options.now ?? Date.now(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      prices: captureUserCostOverlaySnapshot(),
    } satisfies UsageCompactionWorkerInput }, 30 * 60_000);
    return { path, targetPath, snapshot, catchUp: () => request({ type: "catch-up" }), close };
  } catch (error) { await close(); throw error; }
}

/** Finish a small append suffix in one owner-thread turn so live traffic cannot starve publication. */
function catchUpForPublication(
  prepared: PreparedUsageCompaction,
  snapshot: Extract<UsageCompactionWorkerReply, { kind: "prepared" }>,
): Extract<UsageCompactionWorkerReply, { kind: "prepared" }> | null {
  assertSpendLedgerOwnerHeld(dirname(prepared.path));
  const current = currentUsageLogRevision();
  const previous = snapshot.revision;
  if (!current || usageLogIdentityKey(current) !== usageLogIdentityKey(previous)
    || current.size <= previous.size || current.size - previous.size > 1024 * 1024) return null;
  const readRange = (fd: number, from: number, length: number): Buffer => {
    const bytes = Buffer.alloc(length);
    for (let offset = 0; offset < length;) {
      const count = readSync(fd, bytes, offset, length - offset, from + offset);
      if (count <= 0) throw new Error("usage ledger shrank during publication");
      offset += count;
    }
    return bytes;
  };
  const source = openSync(prepared.path, "r");
  let suffix: Buffer;
  try {
    const identity = exactFileIdentity(source);
    if (identity.dev !== current.dev || identity.ino !== current.ino) return null;
    const boundaryStart = Math.max(0, previous.size - 64 * 1024);
    const boundary = readRange(source, boundaryStart, previous.size - boundaryStart);
    if (createHash("sha256").update(boundary).digest("hex") !== snapshot.boundaryDigest) return null;
    const joined = readRange(source, previous.size - snapshot.pendingBytes, current.size - previous.size + snapshot.pendingBytes);
    let start = 0;
    for (let end = joined.indexOf(0x0a); end >= 0; end = joined.indexOf(0x0a, start)) {
      if (end + 1 - start > 1024 * 1024) return null;
      const parsed = parseCompactionLine(joined.subarray(start, end + 1));
      if (parsed.rollup || (parsed.entry && parsed.entry.timestamp < snapshot.compactedBefore)) return null;
      start = end + 1;
    }
    if (joined.byteLength - start > 1024 * 1024) return null;
    suffix = joined.subarray(snapshot.pendingBytes);
  } finally { closeSync(source); }
  if (usageLogRevisionKey(currentUsageLogRevision()) !== usageLogRevisionKey(current)) return null;
  const target = openSync(prepared.targetPath, "a");
  try {
    for (let offset = 0; offset < suffix.byteLength;) {
      const written = writeSync(target, suffix, offset, suffix.byteLength - offset);
      if (written <= 0) throw new Error("usage compaction append stalled");
      offset += written;
    }
    fsyncSync(target);
  } finally { closeSync(target); }
  // Full-prefix integrity was checked in the worker; the owner lease makes later cooperating
  // writes append-only. The boundary digest also catches edits adjacent to this final suffix.
  return { ...snapshot, revision: current, currentBytes: snapshot.currentBytes + suffix.byteLength };
}

async function runCompaction(options: UsageCompactionOptions): Promise<UsageCompactionResult> {
  if (options.signal?.aborted) return { kind: "deferred", reason: "aborted" };
  const prepared = await prepareUsageLedgerCompaction(options);
  try {
    let snapshot = prepared.snapshot;
    if (snapshot.kind !== "prepared") return snapshot;
    options.onPrepared?.();
    for (let attempt = 0; attempt < 4; attempt++) {
      if (options.signal?.aborted) return { kind: "deferred", reason: "aborted" };
      if (snapshot.kind !== "prepared") return snapshot;
      if (usageLogRevisionKey(currentUsageLogRevision()) !== usageLogRevisionKey(snapshot.revision)) {
        // Failure-injection callbacks model non-cooperating writers and retain the full-prefix
        // worker verification; ordinary owner-thread appends can finish within this turn.
        const caughtUp = !options.onPrepared && catchUpForPublication(prepared, snapshot);
        if (caughtUp) snapshot = caughtUp;
        else { snapshot = await prepared.catchUp(); continue; }
      }
      const revision = snapshot.revision;
      assertSpendLedgerOwnerHeld(dirname(prepared.path));
      options.beforePublish?.();
      // No await between the final revision check and rename: the owner-thread append cannot
      // interleave. Windows retries recheck the revision before each synchronous attempt.
      renameAtomicFile(prepared.targetPath, prepared.path, undefined, "config", { validateBeforeRename: () => {
        assertSpendLedgerOwnerHeld(dirname(prepared.path));
        if (options.signal?.aborted || usageLogRevisionKey(currentUsageLogRevision()) !== usageLogRevisionKey(revision)) {
          throw new Error("usage ledger revision changed before publication");
        }
      } });
      // The worker fsyncs the candidate. Persist the directory entry where the OS permits it.
      let directory: number | undefined;
      try { directory = openSync(dirname(prepared.path), "r"); fsyncSync(directory); }
      catch { /* directory fsync is unsupported on Windows and some filesystems */ }
      finally { if (directory !== undefined) closeSync(directory); }
      return { kind: "replaced", currentBytes: snapshot.currentBytes,
        removedBytes: Math.max(0, revision.size - snapshot.currentBytes) };
    }
    return { kind: "deferred", reason: "source-changed", currentBytes: currentUsageLogRevision()?.size };
  } finally { await prepared.close(); }
}

/** Serialize migrations and require the existing per-home writer lease for publication. */
export function compactUsageLedger(options: UsageCompactionOptions = {}): Promise<UsageCompactionResult> {
  assertSpendLedgerOwnerHeld();
  if (active) return active;
  const controller = new AbortController();
  activeAbort = controller;
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  active = withStorageWorkerSpawnGate(() => runCompaction({ ...options, signal: controller.signal }))
    .catch((error): UsageCompactionResult => ({ kind: "deferred",
      reason: controller.signal.aborted ? "aborted" : error?.reason === "timeout" ? "timeout" : error?.reason === "worker-failed" ? "worker-failed" : "publication-failed",
      currentBytes: currentUsageLogRevision()?.size }))
    .finally(() => {
      options.signal?.removeEventListener("abort", abort);
      active = null;
      activeAbort = null;
    });
  return active;
}

/** Cancel work and join the worker before releasing the ledger owner or shutting down. */
export async function closeUsageCompaction(): Promise<void> {
  activeAbort?.abort();
  await active;
  await Promise.all([...preparations].map(close => close()));
}
