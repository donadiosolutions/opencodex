import type { TFn } from "../i18n/shared";
import type { UsageHistoryMetadata } from "./usage-history-retention-utils";

export function UsageHistoryRetentionNotice({ history, t }: { history?: UsageHistoryMetadata; t: TFn }) {
  if (!history || history.historicalGranularity !== "day" || history.historicalCostPolicy !== "frozen") return null;
  return <div className="notice usage-history-retention muted" role="status">{t("usage.historyRetention", { days: history.detailRetentionDays })}</div>;
}
