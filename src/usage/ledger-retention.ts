/** Compatibility entrypoint for the former destructive byte ceiling.
 * Accounting-preserving age compaction is owned by compaction.ts; a size ceiling
 * can no longer authorize deleting totals or shortening the seven-day window.
 */
import { currentUsageLogRevision } from "./log";
import { MIN_USAGE_LEDGER_MAX_BYTES } from "./retention-contract";

export class UsageLedgerRevisionChangedError extends Error {
  readonly code = "usage_ledger_revision_changed";
  constructor() { super("usage ledger changed while publishing retention"); this.name = "UsageLedgerRevisionChangedError"; }
}
export type UsageLedgerRetentionResult =
  | { kind: "disabled" }
  | { kind: "unchanged"; currentBytes: number }
  | { kind: "replaced"; currentBytes: number; removedBytes: number }
  | { kind: "deferred"; currentBytes: number; reason: "revision-changed" | "no-boundary" | "accounting-required" };

export function enforceUsageLedgerSizeLimit(maxBytes: number | undefined, _options: { onSpanCopied?: () => void } = {}): UsageLedgerRetentionResult {
  if (maxBytes === undefined || !Number.isSafeInteger(maxBytes) || maxBytes < MIN_USAGE_LEDGER_MAX_BYTES) return { kind: "disabled" };
  const revision = currentUsageLogRevision();
  if (!revision) return { kind: "disabled" };
  return revision.size <= maxBytes
    ? { kind: "unchanged", currentBytes: revision.size }
    : { kind: "deferred", currentBytes: revision.size, reason: "accounting-required" };
}
