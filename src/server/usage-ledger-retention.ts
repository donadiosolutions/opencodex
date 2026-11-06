/** The serving owner schedules age compaction; appends never scan the ledger. */
import { currentUsageLogRevision, setUsageLedgerAppendHook } from "../usage/log";
import { compactUsageLedger, closeUsageCompaction, cleanupAbandonedUsageCompactionFiles } from "../usage/compaction";
import { drainUsageAccountingStore, refreshUsageAccountingStore, lastUsageCompactionBoundary } from "../usage/accounting-store";
import { discardRetainedFailureProjection } from "../usage/failure-projection-cache";
import { rehydrateRequestLogsAfterLedgerReplacement } from "./request-log";
import { USAGE_DETAIL_RETENTION_MS, type UsageLedgerRetentionStatus } from "../usage/retention-contract";
import { spendLedgerOwnerSnapshot } from "../lib/spend-ledger-owner";

const INTERVAL_MS = 3_600_000;
let configuredMaxBytes: number | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let running: Promise<void> | null = null;
let nextRun = 0;

async function invalidateLedgerReaders(): Promise<void> {
  discardRetainedFailureProjection();
  await drainUsageAccountingStore();
  const [{ discardRetainedUsageAggregate }, { closeRequestHistoryIndex, rebuildRequestHistoryIndex }] = await Promise.all([
    import("./management/usage-aggregate-cache"), import("../routing/history/indexer"),
  ]);
  discardRetainedUsageAggregate();
  closeRequestHistoryIndex();
  rehydrateRequestLogsAfterLedgerReplacement();
  // Finish both disposable projections before reporting the migration idle.
  await refreshUsageAccountingStore();
  await rebuildRequestHistoryIndex();
}

function schedule(delay: number): void {
  if (timer !== undefined) return;
  const epoch = generation;
  timer = setTimeout(() => {
    timer = undefined;
    if (epoch !== generation) return;
    nextRun = Date.now() + INTERVAL_MS;
    if (spendLedgerOwnerSnapshot().ownership !== "held" || !currentUsageLogRevision()?.size) {
      schedule(INTERVAL_MS);
      return;
    }
    running = compactUsageLedger().then(async result => {
      if (result.kind === "replaced") {
        await invalidateLedgerReaders();
        console.info(`[usage-retention] compacted history; reclaimed ${result.removedBytes ?? 0} bytes`);
      } else if (result.kind === "deferred") {
        console.warn(`[usage-retention] compaction deferred: ${result.reason ?? "unavailable"}`);
      }
    }).catch(() => {
      console.warn("[usage-retention] compaction deferred; canonical history was preserved");
    }).finally(() => {
      running = null;
      if (epoch === generation) schedule(INTERVAL_MS);
    });
  }, delay);
  timer.unref();
}

/** The old byte ceiling is advisory: it cannot delete unaccounted or recent rows. */
export function setUsageLedgerRetention(maxBytes: number | undefined): void {
  configuredMaxBytes = maxBytes;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  generation++;
  if (spendLedgerOwnerSnapshot().ownership === "held" && !running) cleanupAbandonedUsageCompactionFiles();
  nextRun = Math.max(Date.now(), (lastUsageCompactionBoundary() ?? 0) + USAGE_DETAIL_RETENTION_MS + INTERVAL_MS);
  setUsageLedgerAppendHook(() => { if (!running && Date.now() >= nextRun) schedule(0); });
  schedule(Math.max(250, nextRun - Date.now()));
}

export async function stopUsageLedgerRetention(): Promise<void> {
  generation++;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  setUsageLedgerAppendHook(null);
  await closeUsageCompaction();
  await running;
  await drainUsageAccountingStore();
}

export function usageLedgerRetentionStatus(): UsageLedgerRetentionStatus {
  return {
    ...(configuredMaxBytes !== undefined ? { maxBytes: configuredMaxBytes } : {}),
    currentBytes: currentUsageLogRevision()?.size ?? 0,
  };
}
