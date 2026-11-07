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
  db.query("UPDATE accounting_meta SET value='{}' WHERE key='checkpoint-v1'").run();
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
