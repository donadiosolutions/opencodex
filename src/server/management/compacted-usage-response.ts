import { hasCompactedUsageLedger, HistoricalUsagePrecisionError, readUsageAccounting } from "../../usage/accounting-store";
import type { UsageRange, UsageSurface, UsageSummaryFilterInput } from "../../usage/summary";
import type { UsageTimeWindow } from "../../usage/time-range";

export async function compactedUsageResponse(range: UsageRange, surface: UsageSurface, filter: UsageSummaryFilterInput, window: UsageTimeWindow | undefined, now: number): Promise<{ status: number; body: unknown } | null> {
  if (!hasCompactedUsageLedger()) return null;
  try {
    const result = await readUsageAccounting({ filter, window, now });
    return { status: 200, body: {
      ...result.accumulator.summarize(range, now, surface),
      history: result.history,
      ...(result.usageIncomplete ? { usageIncomplete: true, usageIncompleteReason: "oversized_rows" }
        : result.usageSourceIncomplete ? { usageIncomplete: true } : {}),
      historyTruncated: false, truncatedPrefixBytes: 0, entriesTruncated: false, entriesDropped: 0,
      snapshotWindowStart: result.accumulator.snapshotWindow.start,
      snapshotWindowEnd: result.accumulator.snapshotWindow.end,
    } };
  } catch (error) {
    if (error instanceof HistoricalUsagePrecisionError) return { status: 400, body: { error: error.code, history: error.history } };
    throw error;
  }
}
