import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeRequestHistoryIndex, queryRequestHistory, requestHistoryRowById } from "../../src/routing/history/indexer";
import { appendUsageEntry, readRecentUsageEntries, resetUsageReadCacheForTests, usageLogPath, type PersistedUsageEntry } from "../../src/usage/log";
import { USAGE_DETAIL_RETENTION_MS } from "../../src/usage/retention-contract";

let previousHome: string | undefined;
let testDir = "";
const now = Date.now() + 100_000;

function row(requestId: string, timestamp: number): PersistedUsageEntry {
  return { requestId, timestamp, provider: "openai", model: "gpt", status: 200, durationMs: 1, usageStatus: "reported" };
}

describe("strict usage detail retention", () => {
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-detail-retention-"));
    process.env.OPENCODEX_HOME = testDir;
    resetUsageReadCacheForTests();
    closeRequestHistoryIndex();
  });

  afterEach(() => {
    closeRequestHistoryIndex();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
  });

  test("history pages and direct ids hide requests older than seven days", async () => {
    appendUsageEntry(row("expired", now - USAGE_DETAIL_RETENTION_MS - 1));
    appendUsageEntry(row("recent", now - USAGE_DETAIL_RETENTION_MS + 1));

    const page = await queryRequestHistory({}, undefined, 10, { now });
    expect(page.rows.map(item => item.requestId)).toEqual(["recent"]);
    expect(await requestHistoryRowById("expired", { now })).toBeNull();
    expect((await requestHistoryRowById("recent", { now }))?.requestId).toBe("recent");
  });

  test("startup tail reads only requests inside the detail window", () => {
    appendUsageEntry(row("expired", now - USAGE_DETAIL_RETENTION_MS - 1));
    appendUsageEntry(row("recent", now - USAGE_DETAIL_RETENTION_MS + 1));
    expect(readRecentUsageEntries(10, undefined, { now }).map(item => item.requestId)).toEqual(["recent"]);
    expect(usageLogPath()).toContain(testDir);
  });

  test("versioned rollups never normalize into request rows", () => {
    appendFileSync(usageLogPath(), `${JSON.stringify({ kind: "usage-rollup", schemaVersion: 1, timestamp: now, requestId: "daily-rollup", provider: "openai" })}\n`);
    expect(readRecentUsageEntries(10, undefined, { now }).some(item => item.requestId === "daily-rollup")).toBe(false);
  });
});
