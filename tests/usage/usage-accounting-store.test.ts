import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { closeUsageAccountingStore, readUsageAccounting } from "../../src/usage/accounting-store";
import { summarizeUsage } from "../../src/usage/summary";
import type { PersistedUsageEntry } from "../../src/usage/log";
import { UsageRollupBuilder } from "../../src/usage/rollup";
import { readAccountingKeyUsage, HistoricalUsagePrecisionError } from "../../src/usage/accounting-store";

let home: string;
let previous: string | undefined;
const now = Date.UTC(2026, 10, 6, 12);
const entry = (id: string, timestamp = now): PersistedUsageEntry => ({
  requestId: id, timestamp, provider: "openai", model: "gpt-4o", status: 200,
  durationMs: 100, usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 2 },
});
beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-accounting-"));
  process.env.OPENCODEX_HOME = home;
});
afterEach(() => {
  closeUsageAccountingStore();
  if (previous === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previous;
  removeTreeWithRetry(home);
});

test("persistent accounting survives restart and folds a new append once", async () => {
  const rows = [entry("a"), entry("b", now - 20 * 86_400_000)];
  writeFileSync(join(home, "usage.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const first = await readUsageAccounting({ now });
  expect(first.accumulator.summarize("all", now).summary).toEqual(summarizeUsage(rows, "all", now).summary);
  closeUsageAccountingStore();
  const restarted = await readUsageAccounting({ now });
  expect(restarted.update).toBe("unchanged");
  appendFileSync(join(home, "usage.jsonl"), JSON.stringify(entry("c")) + "\n");
  const appended = await readUsageAccounting({ now });
  expect(appended.accumulator.summarize("all", now).summary.requests).toBe(3);
  expect((await readUsageAccounting({ now })).accumulator.summarize("all", now).summary.requests).toBe(3);
});

test("accounting storage excludes request diagnostics", async () => {
  const row = { ...entry("a"), conversationId: "private-conversation", diagnostics: { private: "do-not-copy" } };
  writeFileSync(join(home, "usage.jsonl"), JSON.stringify(row) + "\n");
  const result = await readUsageAccounting({ now });
  expect(result.accumulator.summarize("all", now).summary.totalTokens).toBe(12);
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(home, "usage-accounting.sqlite"), { readonly: true });
  try { expect(JSON.stringify(db.query("SELECT payload FROM accounting_entries").all())).not.toContain("private-conversation"); }
  finally { db.close(); }
});

test("compacted days and recent entries preserve every report and key lifetime counts", async () => {
  const old = { ...entry("old", now - 20 * 86_400_000), apiKeyId: "key", admissionKind: "configured" as const };
  const recent = { ...entry("recent"), apiKeyId: "key", admissionKind: "configured" as const };
  const builder = new UsageRollupBuilder({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, compactedBefore: now - 7 * 86_400_000 });
  builder.add(old);
  writeFileSync(join(home, "usage.jsonl"), [...builder.finish(), recent].map(row => JSON.stringify(row)).join("\n") + "\n");
  const report = await readUsageAccounting({ now });
  for (const range of ["all", "30d", "7d"] as const) expect(report.accumulator.summarize(range, now).summary).toEqual(summarizeUsage([old, recent], range, now).summary);
  expect((await readUsageAccounting({ now, filter: { provider: "openai", apiKeyId: "key" } })).accumulator.summarize("all", now).summary.totalTokens).toBe(24);
  expect((await readAccountingKeyUsage(["key"], now)).rollup.get("key")).toMatchObject({ totalRequests: 2, requests7d: 1 });
  await expect(readUsageAccounting({ now, window: { since: old.timestamp, until: now } })).rejects.toBeInstanceOf(HistoricalUsagePrecisionError);
});

test("a damaged checkpoint rebuilds without dropping or doubling entries", async () => {
  writeFileSync(join(home, "usage.jsonl"), JSON.stringify(entry("a")) + "\n");
  await readUsageAccounting({ now });
  closeUsageAccountingStore();
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(home, "usage-accounting.sqlite"));
  db.query("UPDATE accounting_meta SET value='{}' WHERE key='checkpoint-v2'").run();
  db.close();
  expect((await readUsageAccounting({ now })).accumulator.summarize("all", now).summary.requests).toBe(1);
});

test("a concurrent refresh cannot mix revisions into an in-flight report", async () => {
  const rows = Array.from({ length: 2001 }, (_, index) => entry(`original-${index}`));
  writeFileSync(join(home, "usage.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await readUsageAccounting({ now });
  const oldReport = readUsageAccounting({ now, filter: { provider: "openai" } });
  await new Promise(resolve => setTimeout(resolve, 0));
  writeFileSync(join(home, "usage.jsonl"), JSON.stringify(entry("replacement")) + "\n");
  const newReport = readUsageAccounting({ now });
  expect((await oldReport).accumulator.summarize("all", now).summary.requests).toBe(2001);
  expect((await newReport).accumulator.summarize("all", now).summary.requests).toBe(1);
});

test("recent precise bounds exclude a compacted portion of the same day", async () => {
  const cutoff = now - 7 * 86_400_000;
  const builder = new UsageRollupBuilder({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, compactedBefore: cutoff });
  builder.add(entry("old", cutoff - 3_600_000));
  writeFileSync(join(home, "usage.jsonl"), [...builder.finish(), entry("recent", cutoff + 3_600_000)].map(row => JSON.stringify(row)).join("\n") + "\n");
  const report = await readUsageAccounting({ now, window: { since: cutoff, until: cutoff + 7_200_000 } });
  expect(report.accumulator.summarize("all", now).summary.requests).toBe(1);
});

test("damaged committed rollups fail while an uncommitted suffix is excluded", async () => {
  const builder = new UsageRollupBuilder({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, compactedBefore: now });
  builder.add(entry("old", now - 86_400_000));
  const lines = builder.finish().map(row => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(join(home, "usage.jsonl"), lines + '{"unfinished":');
  expect((await readUsageAccounting({ now })).accumulator.summarize("all", now).summary.requests).toBe(1);
  closeUsageAccountingStore();
  writeFileSync(join(home, "usage.jsonl"), lines + '{"broken":\n');
  await expect(readUsageAccounting({ now })).rejects.toThrow("Invalid committed");
});


test("source-filtered lifetime reports and facets survive compaction without crossing devices", async () => {
  const { readAccountingSourceFacets } = await import("../../src/usage/accounting-store");
  const old = now - 20 * 86_400_000;
  const rows: PersistedUsageEntry[] = [
    { ...entry("cli-old", old), client: "codex_cli", apiKeyId: "one", admissionKind: "configured" },
    { ...entry("cli-old-2", old), client: "codex_cli", apiKeyId: "one", admissionKind: "configured" },
    { ...entry("claude-old", old), client: "claude_code", surface: "claude", apiKeyId: "two", admissionKind: "configured" },
    { ...entry("cli-recent"), client: "codex_cli", apiKeyId: "one", admissionKind: "configured" },
  ];
  const builder = new UsageRollupBuilder({ timeZone: "UTC", compactedBefore: now - 7 * 86_400_000 });
  rows.slice(0, 3).forEach(row => builder.add(row));
  writeFileSync(join(home, "usage.jsonl"), [...builder.finish(), rows[3]].map(row => JSON.stringify(row)).join("\n") + "\n");
  for (const client of ["all", "codex", "claude_code"] as const) {
    const filter = { sourceFilter: { client, device: { kind: "all" as const } } };
    const report = await readUsageAccounting({ now, filter });
    const expected = (await import("../../src/usage/summary")).createUsageSummaryAccumulator({ mode: "row-unique", filter, timeZone: "UTC" });
    rows.forEach(row => expected.add(row));
    expect(report.accumulator.summarize("all", now)).toEqual(expected.summarize("all", now));
  }
  const removed = await readUsageAccounting({ now, filter: { sourceFilter: { client: "all", device: { kind: "unconfigured" } }, configuredApiKeyIds: ["one"] } });
  expect(removed.accumulator.summarize("all", now).summary.requests).toBe(1);
  const current = await readUsageAccounting({ now, filter: { sourceFilter: { client: "all", device: { kind: "unconfigured" } }, configuredApiKeyIds: ["one", "two"] } });
  expect(current.accumulator.summarize("all", now).summary.requests).toBe(0);
  const facets = await readAccountingSourceFacets({ client: "all", device: { kind: "all" } }, ["one", "two"], { since: old - 86_400_000, until: now });
  expect(facets.apps.codex).toBe(3);
  expect(facets.apps.claude_code).toBe(1);
  expect(facets.devices.find(row => row.device.kind === "key" && row.device.id === "one")?.requests).toBe(3);
  expect(facets.usageIncomplete).toBe(false);
});

test("old rollups retain lifetime totals and disclose missing historical device evidence", async () => {
  const builder = new UsageRollupBuilder({ timeZone: "UTC", compactedBefore: now - 7 * 86_400_000 });
  builder.add({ ...entry("old", now - 20 * 86_400_000), apiKeyId: "one", admissionKind: "configured" });
  const records = builder.finish().map(record => {
    delete record.source;
    record.snapshot.partitions.forEach(partition => delete partition.legacyUnclassifiedRequests);
    return record;
  });
  writeFileSync(join(home, "usage.jsonl"), records.map(row => JSON.stringify(row)).join("\n") + "\n");
  const report = await readUsageAccounting({ now, filter: { sourceFilter: { client: "codex", device: { kind: "all" } } } });
  expect(report.accumulator.summarize("all", now)).toMatchObject({ summary: { requests: 1 }, legacyUnclassifiedRequests: 1 });
  const noKey = await readUsageAccounting({ now, filter: { sourceFilter: { client: "all", device: { kind: "no-key" } } } });
  expect(noKey.accumulator.summarize("all", now).summary.requests).toBe(0);
  expect(noKey.usageSourceIncomplete).toBe(true);
  const otherKey = await readUsageAccounting({ now, filter: { sourceFilter: { client: "all", device: { kind: "key", id: "other" } } } });
  expect(otherKey.accumulator.summarize("all", now).summary.requests).toBe(0);
});
