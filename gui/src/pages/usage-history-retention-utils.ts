export interface UsageHistoryMetadata {
  detailRetentionDays: number;
  detailAvailableFrom: number;
  historicalGranularity: "day";
  historicalCostPolicy: "frozen";
  timeZone: string;
  compactedBefore?: number;
}

export function hasDailyPrecision(start: string, end: string, window?: { since: number; until: number }, history?: UsageHistoryMetadata): boolean {
  const cutoff = history?.compactedBefore;
  return (window && cutoff !== undefined && window.since >= cutoff || /^\d{4}-\d{2}-\d{2}T00:00$/.test(start))
    && (window && cutoff !== undefined && window.until >= cutoff || /^\d{4}-\d{2}-\d{2}T23:59$/.test(end));
}

export function requiresDailyPrecision(start: number, history?: UsageHistoryMetadata): boolean {
  return history?.historicalGranularity === "day"
    && typeof history.compactedBefore === "number"
    && Number.isFinite(history.compactedBefore)
    && start < history.compactedBefore;
}
