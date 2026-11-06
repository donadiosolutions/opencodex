import { describe, expect, test } from "bun:test";
import { createUsageSummaryAccumulator } from "../../src/usage/summary";
import { UsageRollupBuilder, parseUsageRollupRecord } from "../../src/usage/rollup";
import { accountingFilterKey } from "../../src/usage/rollup";
import { buildRouteDecisionTrace } from "../../src/routing/trace";
import { captureUserCostOverlaySnapshot, applyUserCostOverlaySnapshot } from "../../src/usage/user-cost-overlays";
import { projectUsageAccountingEntry } from "../../src/usage/accounting-entry";
import { serviceTierContextFromOutcome } from "../../src/usage/cost";
import type { PersistedUsageEntry } from "../../src/usage/log";

const timestamp = new Date(2026, 9, 1, 12).getTime();
test("recent accounting preserves unknown tier wire pricing evidence", () => {
  const tierOutcome = { canonical: "standard", fastOutcome: "unknown", confirmation: "assumed", wireKind: "service-tier", wireValue: "priority" } as NonNullable<PersistedUsageEntry["tierOutcome"]>;
  expect(serviceTierContextFromOutcome(projectUsageAccountingEntry(row({ tierOutcome })).tierOutcome!))
    .toEqual(serviceTierContextFromOutcome(tierOutcome));
});
function row(overrides: Partial<PersistedUsageEntry> = {}): PersistedUsageEntry {
  return { requestId: "request-secret", timestamp, provider: "openai", model: "gpt-4o", status: 200,
    durationMs: 100, usageStatus: "reported", usage: { inputTokens: 100, outputTokens: 10 }, ...overrides };
}

describe("durable numeric usage snapshots", () => {
  test("JSON roundtrip merges, appends and does not retain request identities", () => {
    const source = createUsageSummaryAccumulator({ mode: "row-unique" });
    source.add(row());
    const encoded = JSON.stringify(source.exportSnapshot());
    expect(encoded).not.toContain("request-secret");
    const target = createUsageSummaryAccumulator({ mode: "row-unique" });
    target.mergeSnapshot(JSON.parse(encoded));
    expect(target.summarize("all", timestamp)).toEqual(source.summarize("all", timestamp));
    target.add(row());
    expect(target.summarize("all", timestamp).summary.requests).toBe(2);
  });
  test("builds parseable rollups and drops diagnostic details", () => {
    const builder = new UsageRollupBuilder({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, compactedBefore: timestamp + 1 });
    builder.add(row({ apiKeyId: "key-1", admissionKind: "configured", conversationId: "conversation-secret" }));
    const records = builder.finish();
    expect(records.length).toBe(8);
    expect(records.every(record => parseUsageRollupRecord(JSON.parse(JSON.stringify(record))) !== null)).toBe(true);
    expect(JSON.stringify(records)).not.toContain("request-secret");
    expect(JSON.stringify(records)).not.toContain("conversation-secret");
    expect(records.find(record => record.snapshot.filter === null)?.keyUsage).toEqual({ configuredRequests: { "key-1": 1 }, lastUsedAt: { "key-1": timestamp }, attributionSince: timestamp });
    expect(projectUsageAccountingEntry(row({ conversationId: "conversation-secret" }))).not.toHaveProperty("conversationId");
  });
});


test("every observed filter matches raw combo accounting, including provider/key margins", () => {
  const entries = [row({ apiKeyId: "key-1", admissionKind: "configured", attempts: [
    { ordinal: 0, provider: "openai", model: "gpt-4o", adapter: "a", status: 200, durationMs: 50,
      sendCount: 1, recoveryKinds: [], usageStatus: "reported", usage: { inputTokens: 80, outputTokens: 12 } },
    { ordinal: 1, provider: "anthropic", model: "claude-sonnet-4-5", adapter: "b", status: 200, durationMs: 40,
      sendCount: 1, recoveryKinds: [], usageStatus: "reported", usage: { inputTokens: 70, outputTokens: 15 } },
    { ordinal: 2, provider: "openai", model: "gpt-4o", adapter: "a", status: 429, durationMs: 20,
      sendCount: 1, recoveryKinds: [], usageStatus: "unreported" },
  ], spend: { sends: 3, settled: 3, unresolved: 0 } }), row({ requestId: "second", apiKeyId: "key-2", surface: "grok" })];
  const builder = new UsageRollupBuilder({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, compactedBefore: timestamp + 1 });
  entries.forEach(entry => builder.add(entry));
  const records = builder.finish();
  const filters = new Map(records.map(record => [accountingFilterKey(record.snapshot.filter), record.snapshot.filter]));
  for (const [key, filter] of filters) {
    const raw = createUsageSummaryAccumulator({ mode: "row-unique", ...(filter ? { filter } : {}) });
    entries.forEach(entry => raw.add(entry));
    const merged = createUsageSummaryAccumulator({ mode: "row-unique", ...(filter ? { filter } : {}) });
    records.filter(record => accountingFilterKey(record.snapshot.filter) === key).forEach(record => merged.mergeSnapshot(record.snapshot));
    for (const surface of ["all", "codex", "grok", "claude"] as const) {
      expect(merged.summarize("all", timestamp, surface)).toEqual(raw.summarize("all", timestamp, surface));
    }
  }
  const second = new UsageRollupBuilder({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, compactedBefore: timestamp + 2 });
  records.forEach(record => second.addRollup(record));
  expect(second.finish().map(record => record.snapshot)).toEqual(records.map(record => record.snapshot));
});

test("snapshot costs stay frozen when current prices change", () => {
  const original = captureUserCostOverlaySnapshot();
  try {
    const pricing = (input: number) => applyUserCostOverlaySnapshot({
      configuredProviders: ["frozen-test"], accountPricingProviders: [],
      rows: [{ provider: "frozen-test", modelId: "frozen-model", cost4: { input, output: input, cacheRead: input, cacheWrite: input }, source: "user", verifiedAt: "2026-10-01", status: "verified" }],
    });
    pricing(10);
    const old = createUsageSummaryAccumulator({ mode: "row-unique" });
    const entry = row({ provider: "frozen-test", model: "frozen-model" });
    old.add(entry);
    const frozen = old.summarize("all", timestamp).summary.estimatedCostUsd;
    expect(frozen).toBeGreaterThan(0);
    const snapshot = JSON.parse(JSON.stringify(old.exportSnapshot()));
    pricing(100);
    const merged = createUsageSummaryAccumulator({ mode: "row-unique" });
    merged.mergeSnapshot(snapshot);
    expect(merged.summarize("all", timestamp).summary.estimatedCostUsd).toBe(frozen);
    merged.add(entry);
    expect(merged.summarize("all", timestamp).summary.estimatedCostUsd).toBeCloseTo(frozen * 11);
  } finally { applyUserCostOverlaySnapshot(original); }
});

test("rejects invalid snapshots, incompatible filters, and exact-mode imports", () => {
  const source = createUsageSummaryAccumulator({ mode: "row-unique" }); source.add(row());
  const snapshot = source.exportSnapshot();
  const target = createUsageSummaryAccumulator({ mode: "row-unique" });
  for (const mutate of [
    (value: any) => { value.version = 2; },
    (value: any) => { value.partitions[0].totals.inputTokens = -1; },
    (value: any) => { value.partitions[0].models[0][1].requestFacts = [[1, 1]]; },
    (value: any) => { value.partitions[0].models[0][1].firstSeen = NaN; },
    (value: any) => { value.requestId = "leak"; },
    (value: any) => { value.partitions.push(value.partitions[0]); },
  ]) {
    const invalid = structuredClone(snapshot); mutate(invalid);
    expect(() => target.mergeSnapshot(invalid)).toThrow();
    expect(target.summarize("all", timestamp).summary.requests).toBe(0);
  }
  expect(() => createUsageSummaryAccumulator().mergeSnapshot(snapshot)).toThrow();
  expect(() => createUsageSummaryAccumulator().exportSnapshot()).toThrow();
  expect(() => createUsageSummaryAccumulator({ mode: "row-unique", filter: { model: "else" } }).mergeSnapshot(snapshot)).toThrow();
  expect(parseUsageRollupRecord(row())).toBeNull();
  expect(() => parseUsageRollupRecord({ kind: "usage-rollup", version: 2 })).toThrow();
});

test("bounded accounting projection preserves unresolved models, tiers, attempts and totals", () => {
  const model = "openai/gpt-4o";
  const entry = row({ requestId: "safe-id", provider: "kimi", model, conversationId: "secret", upstreamError: "secret",
    usage: { inputTokens: 100, outputTokens: 5, rawUsage: { secret: "payload" } },
    routeDecision: buildRouteDecisionTrace({ requestedModel: model, routeKind: "default-provider",
      selected: { provider: "kimi", model, reason: "default-provider" } }),
    tierOutcome: { canonical: "priority", fastOutcome: "applied", confirmation: "assumed", wireValue: "secret" },
  });
  const projected = projectUsageAccountingEntry(entry);
  expect(JSON.stringify(projected)).not.toContain("secret");
  expect(projected.usage).not.toHaveProperty("rawUsage");
  const summary = (input: PersistedUsageEntry) => { const a = createUsageSummaryAccumulator({ mode: "row-unique" }); a.add(input); return a.summarize("all", timestamp); };
  expect(summary(projected)).toEqual(summary(entry));
});

test("window imports select whole intersecting days and key metadata includes other admissions", () => {
  const yesterday = timestamp - 86_400_000;
  const builder = new UsageRollupBuilder({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, compactedBefore: timestamp + 1 });
  builder.add(row({ timestamp: yesterday, admissionKind: "environment", apiKeyId: "ignored" }));
  builder.add(row({ admissionKind: "configured", apiKeyId: "real" }));
  const records = builder.finish().filter(record => record.snapshot.filter === null);
  const accumulator = createUsageSummaryAccumulator({ mode: "row-unique", window: { since: timestamp - 1, until: timestamp + 1 } });
  records.forEach(record => accumulator.mergeSnapshot(record.snapshot));
  expect(accumulator.summarize("all", timestamp).summary.requests).toBe(1);
  expect(records[0]?.keyUsage).toEqual({ configuredRequests: {}, lastUsedAt: {}, attributionSince: yesterday });
});
