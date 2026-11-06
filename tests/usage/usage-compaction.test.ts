import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSpendLedgerOwner, type SpendLedgerOwnerLease } from "../../src/lib/spend-ledger-owner";
import { compactUsageLedger, closeUsageCompaction, prepareUsageLedgerCompaction, cleanupAbandonedUsageCompactionFiles } from "../../src/usage/compaction";
import { createUsageSummaryAccumulator } from "../../src/usage/summary";
import { parseUsageRollupRecord } from "../../src/usage/rollup";
import { usageLogPath } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const now = Date.UTC(2026, 10, 6, 12);
const day = 86_400_000;
const row = (timestamp: number, requestId: string) => JSON.stringify({ requestId, timestamp,
  provider: "openai", model: "gpt-4o", status: 200, durationMs: 10, usageStatus: "reported",
  usage: { inputTokens: 20, outputTokens: 4 }, unknownFutureField: { preserved: true } });
let home: string;
let previousHome: string | undefined;
let lease: SpendLedgerOwnerLease;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-usage-compaction-"));
  process.env.OPENCODEX_HOME = home;
  lease = acquireSpendLedgerOwner();
});
afterEach(async () => {
  await closeUsageCompaction();
  lease.release();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("usage ledger compaction", () => {
  test("folds expired rows, retains exact recent bytes and partial EOF, and is idempotent", async () => {
    const recent = `  ${row(now - day, "recent")}\r\n`;
    const partial = '{"requestId":"unfinished"';
    writeFileSync(usageLogPath(), `${row(now - 8 * day, "old")}\n${recent}${partial}`);
    const progress: string[] = [];
    expect((await compactUsageLedger({ now, onProgress: event => { progress.push(event.phase); } })).kind).toBe("replaced");
    expect(progress).toContain("scan");
    expect(progress).toContain("verify");
    expect(progress).toContain("write");
    const result = readFileSync(usageLogPath(), "utf8");
    expect(result.startsWith('{"kind":"usage-rollup","version":1,')).toBe(true);
    expect(result.endsWith(recent + partial)).toBe(true);
    expect(result).not.toContain('"requestId":"old"');
    expect((await compactUsageLedger({ now })).kind).toBe("unchanged");
    expect(readFileSync(usageLogPath(), "utf8")).toBe(result);
  });
  for (const invalid of ['{"requestId":"bad","provider":"openai","timestamp":"yesterday"}\n',
    '{"kind":"usage-rollup","version":99}\n', '{broken}\n', `${"x".repeat(1024 * 1024 + 1)}\n`]) {
    test(`preserves original on invalid input (${invalid.slice(0, 30)})`, async () => {
      const original = `${row(now - 8 * day, "old")}\n${invalid}`;
      writeFileSync(usageLogPath(), original);
      expect((await compactUsageLedger({ now })).kind).toBe("deferred");
      expect(readFileSync(usageLogPath(), "utf8")).toBe(original);
      expect(readdirSync(home).filter(name => name.includes("compaction-"))).toEqual([]);
    });
  }
  for (const outputTokens of [-5, NaN, null]) {
    test(`rejects malformed usage counter ${String(outputTokens)} without replacing raw evidence`, async () => {
      const invalid = JSON.parse(row(now - 8 * day, "invalid-counter"));
      invalid.usage.outputTokens = outputTokens;
      const original = `${JSON.stringify(invalid)}\n`;
      writeFileSync(usageLogPath(), original);
      expect((await compactUsageLedger({ now })).kind).toBe("deferred");
      expect(readFileSync(usageLogPath(), "utf8")).toBe(original);
    });
  }
  for (const defect of ["negative-attempt-usage", "invalid-adapter", "null-attempt-total", "nonarray-attempts", "invalid-spend", "invalid-tier"] as const) {
    test(`preserves raw evidence when accounting normalization would discard ${defect}`, async () => {
      const invalid = JSON.parse(row(now - 8 * day, "invalid-attempt"));
      delete invalid.usage;
      const attempt = { ordinal: 1, provider: "openai", model: "gpt-4o", adapter: "openai", status: 200,
        durationMs: 10, sendCount: 1, usageStatus: "reported", usage: { inputTokens: 20, outputTokens: 4 }, recoveryKinds: [] };
      invalid.attempts = [attempt];
      if (defect === "negative-attempt-usage") attempt.usage.inputTokens = -1;
      if (defect === "invalid-adapter") invalid.attempts[0].adapter = null;
      if (defect === "null-attempt-total") invalid.attempts[0].totalTokens = null;
      if (defect === "nonarray-attempts") invalid.attempts = {};
      if (defect === "invalid-spend") invalid.spend = { sends: 1, settled: 2, unresolved: 0 };
      if (defect === "invalid-tier") invalid.attempts[0].tierOutcome = { fastOutcome: "future", confirmation: "confirmed" };
      const original = `${JSON.stringify(invalid)}\n`;
      writeFileSync(usageLogPath(), original);
      expect((await compactUsageLedger({ now })).kind).toBe("deferred");
      expect(readFileSync(usageLogPath(), "utf8")).toBe(original);
    });
  }
  test("accepts an honest empty attempt roster from an older ledger", async () => {
    const entry = JSON.parse(row(now - 8 * day, "empty-roster"));
    entry.attempts = [];
    writeFileSync(usageLogPath(), `${JSON.stringify(entry)}\n`);
    expect((await compactUsageLedger({ now })).kind).toBe("replaced");
  });
  test("accepts a preexisting normalization-loss flag without introducing new attempt loss", async () => {
    const entry = JSON.parse(row(now - 8 * day, "already-recorded"));
    entry.attemptNormalizationDropped = true;
    entry.attempts = [];
    writeFileSync(usageLogPath(), `${JSON.stringify(entry)}\n`);
    expect((await compactUsageLedger({ now })).kind).toBe("replaced");
  });
  test("rejects generated rollups whose finite source counters overflow", async () => {
    const invalid = JSON.parse(row(now - 8 * day, "overflow"));
    invalid.usage.outputTokens = 1e308;
    const original = `${JSON.stringify(invalid)}\n${JSON.stringify(invalid)}\n`;
    writeFileSync(usageLogPath(), original);
    expect((await compactUsageLedger({ now })).kind).toBe("deferred");
    expect(readFileSync(usageLogPath(), "utf8")).toBe(original);
  });
  test("removes only abandoned exact-name regular compaction files while owning an idle ledger", () => {
    const deadPid = 2_147_483_647;
    const stem = `.usage-compaction-${deadPid}-12345678-1234-4234-8234-123456789abc`;
    const raw = join(home, `${stem}.raw`);
    const candidate = join(home, `${stem}.new`);
    writeFileSync(raw, "old details");
    writeFileSync(candidate, "old candidate");
    const live = join(home, `.usage-compaction-${process.pid}-12345678-1234-4234-8234-123456789abc.raw`);
    writeFileSync(live, "live");
    const unrelated = join(home, `${stem}.txt`);
    writeFileSync(unrelated, "unrelated");
    const nonUuid = join(home, `.usage-compaction-${deadPid}-not-a-uuid.raw`);
    writeFileSync(nonUuid, "unrelated");
    const directory = join(home, `.usage-compaction-${deadPid}-22345678-1234-4234-8234-123456789abc.raw`);
    mkdirSync(directory);
    const link = join(home, `.usage-compaction-${deadPid}-32345678-1234-4234-8234-123456789abc.new`);
    if (process.platform !== "win32") symlinkSync(unrelated, link);
    expect(cleanupAbandonedUsageCompactionFiles()).toBe(2);
    expect(existsSync(raw)).toBe(false);
    expect(existsSync(candidate)).toBe(false);
    for (const path of [live, unrelated, nonUuid, directory, ...(process.platform === "win32" ? [] : [link])]) expect(existsSync(path)).toBe(true);
    lease.release();
    expect(() => cleanupAbandonedUsageCompactionFiles()).toThrow("ownership");
    lease = acquireSpendLedgerOwner();
  });
  test("abandoned cleanup rejects an active preparation", async () => {
    writeFileSync(usageLogPath(), `${row(now - 8 * day, "old")}\n`);
    const prepared = await prepareUsageLedgerCompaction({ now });
    expect(() => cleanupAbandonedUsageCompactionFiles()).toThrow("active");
    await prepared.close();
  });
  test("catches a concurrent append without dropping or changing it", async () => {
    const old = `${row(now - 8 * day, "old")}\n`;
    const appended = `${row(now, "append")}\n`;
    writeFileSync(usageLogPath(), old);
    let called = false;
    const result = await compactUsageLedger({ now, onPrepared: () => {
      if (!called) { called = true; appendFileSync(usageLogPath(), appended); }
    } });
    expect(result.kind).toBe("replaced");
    expect(readFileSync(usageLogPath(), "utf8").endsWith(appended)).toBe(true);
  });
  test("publishes a busy append suffix without restarting the full worker digest", async () => {
    writeFileSync(usageLogPath(), `${row(now - 8 * day, "old")}\n`);
    let appended = false;
    let verifications = 0;
    let suffix = "";
    const result = await compactUsageLedger({ now, onProgress: progress => {
      if (progress.phase === "verify" && progress.processedBytes === 0) verifications++;
      if (progress.phase === "write" && !appended) {
        appended = true;
        for (let index = 0; index < 100; index++) {
          const line = `${row(now, `busy-${index}`)}\n`;
          appendFileSync(usageLogPath(), line);
          suffix += line;
        }
      }
    } });
    expect(result.kind).toBe("replaced");
    expect(verifications).toBe(1);
    expect(readFileSync(usageLogPath(), "utf8").endsWith(suffix)).toBe(true);
  });
  test("bounded owner catchup joins a partial row before validating appended bytes", async () => {
    const partial = row(now, "partial");
    const suffix = `${partial.slice(30)}\n${row(now, "last")}\n`;
    writeFileSync(usageLogPath(), `${row(now - 8 * day, "old")}\n${partial.slice(0, 30)}`);
    let appended = false;
    let verifications = 0;
    const result = await compactUsageLedger({ now, onProgress: progress => {
      if (progress.phase === "verify" && progress.processedBytes === 0) verifications++;
      if (progress.phase === "write" && !appended) { appended = true; appendFileSync(usageLogPath(), suffix); }
    } });
    expect(result.kind).toBe("replaced");
    expect(verifications).toBe(1);
    expect(readFileSync(usageLogPath(), "utf8").endsWith(`${partial}\n${row(now, "last")}\n`)).toBe(true);
  });
  test("owner catchup sends an expired append back through worker accounting", async () => {
    writeFileSync(usageLogPath(), `${row(now - 8 * day, "old")}\n`);
    let appended = false;
    let verifications = 0;
    const result = await compactUsageLedger({ now, onProgress: progress => {
      if (progress.phase === "verify" && progress.processedBytes === 0) verifications++;
      if (progress.phase === "write" && !appended) {
        appended = true;
        appendFileSync(usageLogPath(), `${row(now - 9 * day, "late-old")}\n`);
      }
    } });
    expect(result.kind).toBe("replaced");
    expect(verifications).toBe(2);
    expect(readFileSync(usageLogPath(), "utf8")).not.toContain('"requestId":"late-old"');
  });
  test("owner catchup refuses malformed appended complete rows", async () => {
    const original = `${row(now - 8 * day, "old")}\n`;
    const invalid = '{"timestamp":null}\n';
    writeFileSync(usageLogPath(), original);
    let appended = false;
    const result = await compactUsageLedger({ now, onProgress: progress => {
      if (progress.phase === "write" && !appended) {
        appended = true;
        appendFileSync(usageLogPath(), invalid);
      }
    } });
    expect(result.kind).toBe("deferred");
    expect(readFileSync(usageLogPath(), "utf8")).toBe(original + invalid);
  });
  test("refuses replacement or rewritten prefix even when a suffix was appended", async () => {
    const original = `${row(now - 8 * day, "old")}\n`;
    writeFileSync(usageLogPath(), original);
    const changed = `${row(now - 8 * day, "new")}\n${row(now, "append")}\n`;
    const result = await compactUsageLedger({ now, onPrepared: () => writeFileSync(usageLogPath(), changed) });
    expect(result.kind).toBe("deferred");
    expect(readFileSync(usageLogPath(), "utf8")).toBe(changed);
  });
  test("rename failure leaves source and cleans only owned temporary files", async () => {
    const original = `${row(now - 8 * day, "old")}\n`;
    writeFileSync(usageLogPath(), original);
    const unrelated = join(home, "unrelated");
    writeFileSync(unrelated, "leave me");
    expect((await compactUsageLedger({ now, beforePublish: () => { throw new Error("injected failure"); } })).kind).toBe("deferred");
    expect(readFileSync(usageLogPath(), "utf8")).toBe(original);
    expect(readFileSync(unrelated, "utf8")).toBe("leave me");
    expect(readdirSync(home).filter(name => name.includes("compaction-"))).toEqual([]);
  });
  test("preserves aggregate tokens and exact cutoff across repeated migrations", async () => {
    const lines = [row(now - 9 * day, "older"), row(now - 8 * day, "old"), row(now - 7 * day, "boundary"), row(now, "new")];
    const expected = createUsageSummaryAccumulator({ mode: "row-unique" });
    for (const line of lines) expected.add(JSON.parse(line));
    writeFileSync(usageLogPath(), `${lines.join("\n")}\n`);
    expect((await compactUsageLedger({ now })).kind).toBe("replaced");
    expect(readFileSync(usageLogPath(), "utf8")).toContain(`${lines[2]}\n`);
    expect((await compactUsageLedger({ now: now + 2 * day })).kind).toBe("replaced");
    const actual = createUsageSummaryAccumulator({ mode: "row-unique" });
    for (const line of readFileSync(usageLogPath(), "utf8").trim().split("\n")) {
      const parsed = JSON.parse(line);
      const rollup = parseUsageRollupRecord(parsed);
      if (rollup) { if (rollup.snapshot.filter === null) actual.mergeSnapshot(rollup.snapshot); }
      else actual.add(parsed);
    }
    expect(actual.summarize("all", now + 2 * day).summary).toEqual(expected.summarize("all", now + 2 * day).summary);
  });
  test("completes a partial suffix and preserves append order", async () => {
    const first = row(now, "partial");
    const second = row(now, "second");
    writeFileSync(usageLogPath(), `${row(now - 8 * day, "old")}\n${first.slice(0, 50)}`);
    const result = await compactUsageLedger({ now, onPrepared: () => {
      appendFileSync(usageLogPath(), `${first.slice(50)}\n${second}\n`);
    } });
    expect(result.kind).toBe("replaced");
    expect(readFileSync(usageLogPath(), "utf8").endsWith(`${first}\n${second}\n`)).toBe(true);
  });
  test("refuses a replaced source identity", async () => {
    writeFileSync(usageLogPath(), `${row(now - 8 * day, "old")}\n`);
    const replacement = `${row(now, "replacement")}\n`;
    const result = await compactUsageLedger({ now, onPrepared: () => {
      writeFileSync(join(home, "replacement"), replacement);
      renameSync(join(home, "replacement"), usageLogPath());
    } });
    expect(result.kind).toBe("deferred");
    expect(readFileSync(usageLogPath(), "utf8")).toBe(replacement);
  });
  test("preserves the stored reporting timezone when the host uses another zone", async () => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone === "Pacific/Honolulu" ? "Asia/Tokyo" : "Pacific/Honolulu";
    const timestamp = Date.UTC(2026, 9, 29, 2);
    const stored = createUsageSummaryAccumulator({ mode: "row-unique", timeZone });
    stored.add(JSON.parse(row(timestamp, "stored")));
    const persisted = { kind: "usage-rollup", version: 1, timeZone,
      compactedBefore: now - 7 * day, snapshot: stored.exportSnapshot() };
    const expiredRaw = row(timestamp + 30 * 60_000, "expired");
    const recentRaw = row(now, "recent");
    writeFileSync(usageLogPath(), `${JSON.stringify(persisted)}\n${expiredRaw}\n${recentRaw}\n`);
    expect((await compactUsageLedger({ now })).kind).toBe("replaced");
    const restored = createUsageSummaryAccumulator({ mode: "row-unique", timeZone });
    for (const line of readFileSync(usageLogPath(), "utf8").trim().split("\n")) {
      const parsed = JSON.parse(line);
      const rollup = parseUsageRollupRecord(parsed);
      if (rollup) {
        expect(rollup.timeZone).toBe(timeZone);
        if (rollup.snapshot.filter === null) restored.mergeSnapshot(rollup.snapshot);
      } else restored.add(parsed);
    }
    stored.add(JSON.parse(expiredRaw));
    stored.add(JSON.parse(recentRaw));
    expect(restored.summarize("all", now)).toEqual(stored.summarize("all", now));
  });
  test("last-moment append prevents atomic replacement", async () => {
    const original = `${row(now - 8 * day, "old")}\n`;
    const appended = `${row(now, "late")}\n`;
    writeFileSync(usageLogPath(), original);
    const result = await compactUsageLedger({ now, beforePublish: () => appendFileSync(usageLogPath(), appended) });
    expect(result.kind).toBe("deferred");
    expect(readFileSync(usageLogPath(), "utf8")).toBe(original + appended);
  });
  test("shutdown drains externally prepared worker without publishing", async () => {
    const original = `${row(now - 8 * day, "old")}\n`;
    writeFileSync(usageLogPath(), original);
    const prepared = await prepareUsageLedgerCompaction({ now });
    expect(prepared.snapshot.kind).toBe("prepared");
    await closeUsageCompaction();
    await prepared.close();
    expect(readFileSync(usageLogPath(), "utf8")).toBe(original);
    expect(readdirSync(home).filter(name => name.includes("compaction-"))).toEqual([]);
  });
  test("publication requires the per-home owner and abort drains worker", async () => {
    writeFileSync(usageLogPath(), `${row(now - 8 * day, "old")}\n`);
    lease.release();
    expect(() => compactUsageLedger({ now })).toThrow("ownership");
    lease = acquireSpendLedgerOwner();
    const controller = new AbortController();
    controller.abort();
    expect((await compactUsageLedger({ now, signal: controller.signal })).kind).toBe("deferred");
  });
});
