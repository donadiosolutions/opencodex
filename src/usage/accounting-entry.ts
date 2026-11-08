import type { PersistedUsageAttempt, PersistedUsageEntry } from "./log";
import { isUnresolvedRequestedModel } from "./model-identity";

function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) if (source[key] !== undefined) result[key] = source[key];
  return result;
}
function projectUsage(usage: NonNullable<PersistedUsageEntry["usage"]>): NonNullable<PersistedUsageEntry["usage"]> {
  return pick(usage, ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheReadInputTokens",
    "cacheCreationInputTokens", "cacheCreation1hInputTokens", "reasoningOutputTokens", "estimated"]);
}
function projectAttempt(attempt: PersistedUsageAttempt): PersistedUsageAttempt {
  return {
    ...pick(attempt, ["ordinal", "provider", "model", "status", "durationMs", "sendCount", "usageStatus",
      "totalTokens", "cacheProvenance", "accountLogLabel", "streamAborted", "firstOutputMs", "locallyAnswered"]),
    ...(attempt.usage ? { usage: projectUsage(attempt.usage) } : {}),
    // Required schema fields carry no accounting data.
    adapter: "", recoveryKinds: [],
    ...(attempt.tierOutcome ? { tierOutcome: projectTier(attempt.tierOutcome) } : {}),
  };
}
function projectTier(outcome: NonNullable<PersistedUsageEntry["tierOutcome"]>): NonNullable<PersistedUsageEntry["tierOutcome"]> {
  return {
    ...pick(outcome, ["canonical", "fastOutcome", "confirmation", "responseServiceTier", "responseTierAuthoritative"]),
    ...(outcome.fastOutcome === "unknown" && outcome.wireKind === "service-tier"
      ? pick(outcome, ["wireKind", "wireValue"]) : {}),
  };
}

/** Recent accounting retains meter facts; diagnostics have a separate retention horizon. */
export function projectUsageAccountingEntry(entry: PersistedUsageEntry): PersistedUsageEntry {
  const result: PersistedUsageEntry = {
    ...pick(entry, ["requestId", "timestamp", "provider", "model", "surface", "client", "apiKeyId", "admissionKind",
      "accountLogLabel", "resolvedModel", "status", "durationMs", "usageStatus", "totalTokens",
      "cacheProvenance", "responseServiceTier", "requestedServiceTier", "configuredServiceTier"]),
    ...(entry.usage ? { usage: projectUsage(entry.usage) } : {}),
    ...(entry.attempts ? { attempts: entry.attempts.map(projectAttempt) } : {}),
    ...(entry.tierOutcome ? { tierOutcome: projectTier(entry.tierOutcome) } : {}),
    ...(entry.spend ? { spend: pick(entry.spend, ["sends", "settled", "unresolved", "reserved"]) } : {}),
  };
  // Preserve just the derivative model fact. The original decision id, candidates,
  // requirements and routing evidence are deliberately not accounting data.
  if ([entry, ...(entry.attempts ?? [])].some(target => isUnresolvedRequestedModel(entry, target))) {
    const selected = entry.routeDecision!.selected;
    result.routeDecision = {
      version: 1, decisionId: "accounting-model-identity", createdAt: 0,
      requestedModel: selected.model, routeKind: "default-provider", requirements: [], candidates: [],
      selected: { candidateIndex: 0, provider: selected.provider, model: selected.model, reason: "default-provider" },
    };
  }
  return structuredClone(result);
}
