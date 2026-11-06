/**
 * The usage-ledger retention limits, stated once for the schema, the server and the dashboard.
 *
 * Import-free, for the reason `telemetry-contract.ts` gives: the dashboard is a separate
 * TypeScript project, and a type-only import still drags the imported file's whole graph into
 * the browser build. Anything added here must keep that property.
 */

/**
 * Below this a ceiling cannot hold even one large row plus its successor, so a value under it is
 * treated as unset rather than enforced into an empty ledger.
 */
export const MIN_USAGE_LEDGER_MAX_BYTES = 1024 * 1024;

/** What the dashboard offers when a user turns the limit on. Not a default for the proxy. */
export const SUGGESTED_USAGE_LEDGER_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * Trim to this fraction of the ceiling rather than to the ceiling itself, so the next append does
 * not immediately re-cross it and charge every subsequent append a full rewrite.
 */
export const USAGE_LEDGER_RETENTION_TARGET_RATIO = 0.9;

export const USAGE_DETAIL_RETENTION_DAYS = 7;
export const USAGE_DETAIL_RETENTION_MS = USAGE_DETAIL_RETENTION_DAYS * 86_400_000;

let usageDetailTestNow: number | undefined;

export function setUsageDetailNowForTests(now: number | undefined): void {
  usageDetailTestNow = now;
}

export function usageDetailNow(): number {
  return usageDetailTestNow ?? Date.now();
}

export function usageDetailCutoff(now = usageDetailNow()): number {
  return now - USAGE_DETAIL_RETENTION_MS;
}

export interface UsageHistoryMetadata {
  detailRetentionDays: 7;
  detailAvailableFrom: number;
  historicalGranularity: "day";
  historicalCostPolicy: "frozen";
  timeZone: string;
  compactedBefore?: number;
}

export function usageHistoryMetadata(now = Date.now(), compactedBefore?: number, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): UsageHistoryMetadata {
  return {
    detailRetentionDays: 7,
    detailAvailableFrom: usageDetailCutoff(now),
    historicalGranularity: "day",
    historicalCostPolicy: "frozen",
    timeZone,
    ...(compactedBefore === undefined ? {} : { compactedBefore }),
  };
}

export interface UsageLedgerRetentionStatus {
  /** Absent when no limit is configured. */
  maxBytes?: number;
  currentBytes: number;
}
