import { claudeCompatibilityReason, normalizeClaudeFeatureCodes, type ClaudeFeatureCode } from "../claude/compatibility";

export interface PersistedClaudeCompatibilityLog {
  decision: "shadow";
  featureCodes: ClaudeFeatureCode[];
  reason?: string;
}

/** Disk and in-memory callers share a closed-code projection; free-form reasons are discarded. */
export function normalizeClaudeCompatibilityUsageLog(value: unknown): PersistedClaudeCompatibilityLog | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.decision !== "shadow") return undefined;
  const featureCodes = normalizeClaudeFeatureCodes(row.featureCodes);
  const reason = claudeCompatibilityReason(featureCodes, true);
  if (!reason) return undefined;
  return { decision: "shadow", featureCodes, reason };
}
