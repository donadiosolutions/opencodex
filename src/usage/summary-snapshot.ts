import type { UsageSummaryTotals, UsageSurface } from "./summary";
import type { UsageSourceFilter } from "./source-filter";
import type { UsageTimeWindow } from "./time-range";

export type UsagePartitionSurface = Exclude<UsageSurface, "all"> | "other";
export type UsageAccumulatorMode = "exact" | "row-unique";

export interface UsageRequestCounts {
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  pricedRequests: number;
  unpricedRequests: number;
}

export interface UsageModelOverlap {
  models: ReadonlyArray<readonly [modelKey: string, requestFacts: number]>;
  count: number;
}

export interface UsageModelAccumulator {
  provider: string;
  model: string;
  resolvedModel?: string;
  hasUnresolvedRequestedModel?: true;
  firstSeen: number;
  attemptCount: number;
  dayTotalTokens: number;
  summaryTotalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheObserved: boolean;
  /** Input tokens from attributions with OBSERVED cache detail; the hit-rate denominator. */
  cacheObservedInputTokens: number;
  throughputOutputTokens: number;
  throughputDurationMs: number;
  throughputSamples: number;
  estimatedCostUsd?: number;
  requestCounts: UsageRequestCounts;
  requestFacts?: Map<number, number>;
}

export interface UsageAccountAccumulator {
  accountLogLabel: string;
  ambiguous: boolean;
  firstSeen: number;
  requests: number;
  requestIds?: Set<number>;
  attemptCount: number;
  measuredAttempts: number;
  reportedAttempts: number;
  estimatedAttempts: number;
  unmeteredAttempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  pricedAttempts: number;
  unpricedAttempts: number;
}

export interface UsagePartition {
  legacyUnclassifiedRequests?: number;
  comboOverlap: boolean;
  date: string;
  dayStart: number;
  surface: UsagePartitionSurface;
  oldestTimestamp: number | null;
  totals: UsageSummaryTotals;
  models: Map<string, UsageModelAccumulator>;
  providers?: Map<string, UsageModelAccumulator>;
  accounts: Map<string, UsageAccountAccumulator>;
  modelOverlaps: Map<string, UsageModelOverlap>;
}

export interface UsageDayAccumulator {
  totals: UsageSummaryTotals;
  models: Map<string, UsageModelAccumulator>;
  modelOverlaps: UsageModelOverlap[];
}

export interface NormalizedUsageFilter {
  provider: string | null;
  model: string | null;
  apiKeyId: string | null;
  sourceFilter?: UsageSourceFilter;
  configuredApiKeyIds?: readonly string[];
  configuredApiKeyIdSet?: ReadonlySet<string>;
}

/** JSON-safe numeric accounting state. Only row-unique accumulators may export. */
export interface UsageSummarySnapshot {
  version: 1;
  filter: NormalizedUsageFilter | null;
  window?: UsageTimeWindow;
  snapshotWindow: { start: number | null; end: number | null };
  nextOrdinal: number;
  comboOverlap: boolean;
  partitions: UsagePartitionSnapshot[];
}
export interface UsagePartitionSnapshot extends Omit<UsagePartition, "models" | "providers" | "accounts" | "modelOverlaps"> {
  models: [string, Omit<UsageModelAccumulator, "requestFacts">][];
  providers: [string, Omit<UsageModelAccumulator, "requestFacts">][];
  accounts: [string, Omit<UsageAccountAccumulator, "requestIds">][];
  modelOverlaps: UsageModelOverlap[];
}

export function encodeUsagePartition(partition: UsagePartition): UsagePartitionSnapshot {
  return structuredClone({
    ...partition,
    models: [...partition.models],
    providers: [...partition.providers!],
    accounts: [...partition.accounts],
    modelOverlaps: [...partition.modelOverlaps.values()],
  });
}

export function decodeUsagePartition(partition: UsagePartitionSnapshot, ordinalOffset: number): UsagePartition {
  const copy = structuredClone(partition);
  for (const [, model] of [...copy.models, ...copy.providers]) model.firstSeen += ordinalOffset;
  for (const [, account] of copy.accounts) account.firstSeen += ordinalOffset;
  return {
    ...copy,
    models: new Map(copy.models), providers: new Map(copy.providers), accounts: new Map(copy.accounts),
    modelOverlaps: new Map(copy.modelOverlaps.map(overlap => [JSON.stringify(overlap.models), overlap])),
  };
}

const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => number(value) && Number.isSafeInteger(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 65_536;
const nullableNumber = (value: unknown) => value === null || number(value);
type Validator = (value: unknown) => boolean;
function object(value: unknown, required: Record<string, Validator>, optional: Record<string, Validator> = {}): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.entries(required).every(([key, validate]) => Object.hasOwn(record, key) && validate(record[key]))
    && Object.keys(record).every(key => Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && optional[key]!(record[key])));
}
const numeric = (keys: string): Record<string, Validator> => Object.fromEntries(keys.split(" ").map(key => [key, number]));
const totalsRequired = numeric("requests attemptCount measuredRequests reportedRequests unreportedRequests unsupportedRequests estimatedRequests inputTokens outputTokens cachedInputTokens cacheReadInputTokens cacheCreationInputTokens reasoningOutputTokens totalTokens coverageRatio estimatedCostUsd pricedRequests unpricedRequests unmeteredRequests");
const totalsOptional = numeric("sends settledSends unresolvedSends spendRequests cacheObservedInputTokens cacheObservedRequests cacheSynthesizedRequests cacheUnknownRequests throughputOutputTokens throughputDurationMs throughputSamples throughputTokensPerSec");
const requestCounts = (value: unknown) => object(value, numeric("requests measuredRequests reportedRequests estimatedRequests pricedRequests unpricedRequests"));
const model = (value: unknown) => object(value, {
  provider: text, model: text, cacheObserved: value => typeof value === "boolean", requestCounts,
  ...numeric("firstSeen attemptCount dayTotalTokens summaryTotalTokens inputTokens outputTokens cacheReadInputTokens cacheCreationInputTokens cacheObservedInputTokens throughputOutputTokens throughputDurationMs throughputSamples"),
}, { resolvedModel: text, hasUnresolvedRequestedModel: value => value === true, estimatedCostUsd: number });
const account = (value: unknown) => object(value, {
  accountLogLabel: text, ambiguous: value => typeof value === "boolean",
  ...numeric("firstSeen requests attemptCount measuredAttempts reportedAttempts estimatedAttempts unmeteredAttempts inputTokens outputTokens cacheReadInputTokens cacheCreationInputTokens reasoningOutputTokens totalTokens pricedAttempts unpricedAttempts"),
}, { estimatedCostUsd: number });
function pairs(value: unknown, validate: Validator): boolean {
  if (!Array.isArray(value)) return false;
  const keys = new Set<string>();
  return value.every(pair => Array.isArray(pair) && pair.length === 2 && text(pair[0])
    && !keys.has(pair[0]) && !!keys.add(pair[0]) && validate(pair[1]));
}
const overlap = (value: unknown) => object(value, {
  count: integer,
  models: value => pairs(value, facts => integer(facts) && facts > 0 && facts < 64),
});
const partition = (value: unknown) => object(value, {
  comboOverlap: value => typeof value === "boolean",
  date: value => text(value) && /^\d{4}-\d{2}-\d{2}$/.test(value), dayStart: number,
  surface: value => ["codex", "claude", "grok", "other"].includes(value as string),
  oldestTimestamp: nullableNumber, totals: value => object(value, totalsRequired, totalsOptional),
  models: value => pairs(value, model), providers: value => pairs(value, model),
  accounts: value => pairs(value, account), modelOverlaps: value => Array.isArray(value) && value.every(overlap),
}, { legacyUnclassifiedRequests: integer });
const filterValue = (value: unknown) => value === null || (text(value) && value.trim() === value && value.length > 0);
const lowerFilterValue = (value: unknown) => filterValue(value) && (value === null || (value as string).toLowerCase() === value);
export function isUsageSummarySnapshot(value: unknown): value is UsageSummarySnapshot {
  return object(value, {
    version: value => value === 1,
    filter: value => value === null || object(value, { provider: lowerFilterValue, model: lowerFilterValue, apiKeyId: filterValue }),
    snapshotWindow: value => object(value, { start: nullableNumber, end: nullableNumber }),
    nextOrdinal: integer, comboOverlap: value => typeof value === "boolean",
    partitions: value => Array.isArray(value) && value.every(partition),
  }, { window: value => object(value, { since: number, until: number }) });
}

export function assertUsageSummarySnapshot(value: unknown): asserts value is UsageSummarySnapshot {
  if (!isUsageSummarySnapshot(value)) throw new Error("Invalid or unsupported usage summary snapshot");
  const keys = new Set<string>();
  for (const partition of value.partitions) {
    const key = `${partition.date}\0${partition.surface}`;
    if (keys.has(key)) throw new Error("Duplicate usage snapshot partition");
    keys.add(key);
    for (const [key, row] of partition.models) {
      if (key !== `${row.provider}\0${row.model}` || row.firstSeen >= value.nextOrdinal) throw new Error("Invalid usage model identity/order");
    }
    for (const [key, row] of partition.providers) {
      if (key !== row.provider || row.firstSeen >= value.nextOrdinal) throw new Error("Invalid usage provider identity/order");
    }
    for (const [key, row] of partition.accounts) {
      if (key !== row.accountLogLabel || row.firstSeen >= value.nextOrdinal) throw new Error("Invalid usage account identity/order");
    }
    const modelKeys = new Set(partition.models.map(([key]) => key));
    if (partition.modelOverlaps.some(overlap => overlap.models.some(([key]) => !modelKeys.has(key)))) {
      throw new Error("Invalid usage overlap model reference");
    }
  }
  const { start, end } = value.snapshotWindow;
  if ((start === null) !== (end === null) || (start !== null && end !== null && start > end)
    || (value.window && value.window.since > value.window.until)) throw new Error("Invalid usage snapshot bounds");
}
