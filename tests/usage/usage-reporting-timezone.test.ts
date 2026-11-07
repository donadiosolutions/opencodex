import { describe, expect, test } from "bun:test";
import { createUsageSummaryAccumulator, rangeWindow } from "../../src/usage/summary";
import type { PersistedUsageEntry } from "../../src/usage/log";

function entry(iso: string): PersistedUsageEntry {
  return { requestId: iso, timestamp: Date.parse(iso), provider: "openai", model: "gpt-5.5",
    status: 200, durationMs: 10, usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 5 } };
}

describe("fixed reporting timezone", () => {
  test("retains stored calendar partitions and recent rows after the host timezone changes", () => {
    const previous = process.env.TZ;
    try {
      for (const [timeZone, now, rows, expectedSince] of [
        ["America/Sao_Paulo", "2026-11-06T02:00:00Z", ["2026-10-30T02:59:59Z", "2026-10-30T03:00:00Z", "2026-11-06T02:00:00Z"], "2026-10-30T03:00:00Z"],
        ["America/New_York", "2026-03-09T04:30:00Z", ["2026-03-03T04:59:59Z", "2026-03-03T05:00:00Z", "2026-03-08T06:59:59Z", "2026-03-08T07:00:00Z"], "2026-03-03T05:00:00Z"],
        ["America/New_York", "2026-11-02T05:30:00Z", ["2026-10-27T03:59:59Z", "2026-10-27T04:00:00Z", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"], "2026-10-27T04:00:00Z"],
      ] as const) {
        const timestamp = Date.parse(now);
        process.env.TZ = timeZone;
        const expected = createUsageSummaryAccumulator({ mode: "row-unique" });
        const stored = createUsageSummaryAccumulator({ mode: "row-unique" });
        rows.forEach(iso => expected.add(entry(iso)));
        rows.slice(0, -1).forEach(iso => stored.add(entry(iso)));
        const sevenDays = expected.summarize("7d", timestamp);
        const allDays = expected.summarize("all", timestamp);
        expect(sevenDays.since).toBe(Date.parse(expectedSince));
        expect(sevenDays.summary.requests).toBe(rows.length - 1);
        process.env.TZ = "UTC";
        const restored = createUsageSummaryAccumulator({ mode: "row-unique", timeZone });
        restored.mergeSnapshot(stored.exportSnapshot());
        restored.add(entry(rows[rows.length - 1]!));
        expect(restored.summarize("7d", timestamp)).toEqual(sevenDays);
        expect(restored.summarize("all", timestamp)).toEqual(allDays);
        expect(restored.clone().summarize("7d", timestamp)).toEqual(sevenDays);
        expect(rangeWindow("7d", timestamp, timeZone).since).toBe(Date.parse(expectedSince));
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  test("custom windows keep timezone midnight boundaries across DST and skipped dates", () => {
    for (const [timeZone, since, until, dates] of [
      ["America/New_York", "2026-03-08T04:59:00Z", "2026-03-09T04:00:00Z", ["2026-03-07", "2026-03-08", "2026-03-09"]],
      ["America/Sao_Paulo", "2018-11-03T23:00:00Z", "2018-11-05T02:00:00Z", ["2018-11-03", "2018-11-04", "2018-11-05"]],
      ["Pacific/Apia", "2011-12-29T22:00:00Z", "2011-12-30T22:00:00Z", ["2011-12-29", "2011-12-31"]],
    ] as const) {
      const window = { since: Date.parse(since), until: Date.parse(until) };
      const accumulator = createUsageSummaryAccumulator({ mode: "row-unique", timeZone, window });
      accumulator.add(entry(since));
      accumulator.add(entry(until));
      const result = accumulator.summarize("all", window.until);
      expect(result.days.map(day => day.date)).toEqual([...dates]);
      expect(result.summary.requests).toBe(2);
    }
  });

  test("fixed UTC handles custom windows beyond four-digit calendar years", () => {
    const since = Date.parse("9999-12-31T12:00:00Z");
    const until = Date.parse("+010000-01-02T12:00:00Z");
    const accumulator = createUsageSummaryAccumulator({ timeZone: "UTC", window: { since, until } });
    expect(accumulator.summarize("all", until).days.map(day => day.date))
      .toEqual(["9999-12-31", "10000-01-01", "10000-01-02"]);
  });

  test("snapshot projection excludes the prior DST day at the reporting midnight", () => {
    const source = createUsageSummaryAccumulator({ mode: "row-unique", timeZone: "America/New_York" });
    source.add(entry("2026-03-08T12:00:00Z"));
    source.add(entry("2026-03-09T12:00:00Z"));
    const window = { since: Date.parse("2026-03-09T04:00:00Z"), until: Date.parse("2026-03-10T03:59:59Z") };
    const projected = createUsageSummaryAccumulator({ mode: "row-unique", timeZone: "America/New_York", window });
    projected.mergeSnapshot(source.exportSnapshot());
    const summary = projected.summarize("all", window.until);
    expect(summary.summary.requests).toBe(1);
    expect(summary.days.map(day => [day.date, day.requests])).toEqual([["2026-03-09", 1]]);
  });
});
