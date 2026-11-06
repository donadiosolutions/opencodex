import { normalizePersistedUsageRow, type PersistedUsageEntry } from "./log";
import { parseUsageRollupRecord } from "./rollup";
const decoder = new TextDecoder("utf-8", { fatal: true });

function validateUsageCounters(row: Record<string, unknown>): void {
  if ("totalTokens" in row && (typeof row.totalTokens !== "number" || !Number.isFinite(row.totalTokens) || row.totalTokens < 0)) {
    throw new Error("invalid total token count");
  }
  if (!("usage" in row)) return;
  if (!row.usage || typeof row.usage !== "object" || Array.isArray(row.usage)) throw new Error("invalid usage counters");
  const usage = row.usage as Record<string, unknown>;
  for (const key of ["inputTokens", "outputTokens", "contextTotalTokens", "totalTokens", "cachedInputTokens",
    "cacheReadInputTokens", "cacheCreationInputTokens", "cacheCreation1hInputTokens", "reasoningOutputTokens", "providerCredits"]) {
    if ((key === "inputTokens" || key === "outputTokens" || key in usage)
      && (typeof usage[key] !== "number" || !Number.isFinite(usage[key]) || (usage[key] as number) < 0)) {
      throw new Error("invalid usage counters");
    }
  }
}
function validateTierPreserved(raw: Record<string, unknown>, normalized: { tierOutcome?: unknown }): void {
  if (!("tierOutcome" in raw)) return;
  if (!raw.tierOutcome || typeof raw.tierOutcome !== "object" || Array.isArray(raw.tierOutcome)
    || !normalized.tierOutcome || typeof normalized.tierOutcome !== "object") throw new Error("invalid pricing tier");
  const original = raw.tierOutcome as Record<string, unknown>;
  const retained = normalized.tierOutcome as Record<string, unknown>;
  for (const key of ["canonical", "wireKind", "wireValue", "fastOutcome", "fastDowngradeReason", "callerTierDropped",
    "callerFastSuppressedByConfig", "confirmation", "responseTierAuthoritative", "responseServiceTier"]) {
    if (key in original && original[key] !== retained[key]) throw new Error("pricing tier normalization lost evidence");
  }
}

export function parseCompactionLine(line: Buffer): { entry?: PersistedUsageEntry; rollup?: ReturnType<typeof parseUsageRollupRecord> } {
  const text = decoder.decode(line);
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  const rollup = parseUsageRollupRecord(parsed);
  if (rollup) return { rollup };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid usage row");
  const row = parsed as Record<string, unknown>;
  if (row.kind !== undefined || typeof row.timestamp !== "number"
    || !Number.isSafeInteger(row.timestamp) || row.timestamp < 0 || row.timestamp > 8_640_000_000_000_000) {
    throw new Error("invalid usage record or timestamp");
  }
  // Unlike display reads, a destructive migration cannot erase malformed accounting facts.
  validateUsageCounters(row);
  if ("attempts" in row && !Array.isArray(row.attempts)) throw new Error("invalid attempt roster");
  for (const attempt of (row.attempts ?? []) as unknown[]) {
    if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) throw new Error("invalid usage attempt");
    validateUsageCounters(attempt as Record<string, unknown>);
  }
  const entry = normalizePersistedUsageRow(parsed);
  if (!entry) throw new Error("invalid usage row");
  validateTierPreserved(row, entry);
  if ("spend" in row && entry.spend === undefined) throw new Error("spend normalization lost evidence");
  if (Array.isArray(row.attempts)) {
    if (row.attempts.length !== (entry.attempts?.length ?? 0)) throw new Error("attempt normalization lost evidence");
    row.attempts.forEach((attempt, index) => validateTierPreserved(attempt as Record<string, unknown>, entry.attempts![index]!));
  }
  if (entry.attemptNormalizationDropped === true && row.attemptNormalizationDropped !== true) {
    throw new Error("attempt normalization lost evidence");
  }
  return { entry };
}

