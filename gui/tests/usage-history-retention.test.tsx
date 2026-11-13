import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Usage from "../src/pages/Usage";
import { en } from "../src/i18n/en";
import { hasDailyPrecision, requiresDailyPrecision } from "../src/pages/usage-history-retention-utils";
import { resetApiAuthFetchForTests } from "../src/api";
import { clearClientResourceStoresForTests } from "../src/client-resource";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let descriptors: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let browser: Window;
let root: Root | undefined;
let host: HTMLElement;
let request: { url: string; resolve: (response: Response) => void } | undefined;

beforeEach(() => {
  descriptors = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof descriptors;
  clearClientResourceStoresForTests();
  resetApiAuthFetchForTests();
  browser = new Window({ url: "http://localhost/" });
  browser.localStorage.setItem("ocx-lang", "en");
  Object.defineProperties(globalThis, Object.fromEntries(globals.map(key => [key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : (browser as unknown as Record<string, unknown>)[key] }])))
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (new URL(url).pathname !== "/api/usage") return Promise.resolve(Response.json({}, { status: 503 }));
    return new Promise<Response>(resolve => { request = { url, resolve }; });
  }) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  browser.close();
  for (const key of globals) {
    if (descriptors[key]) Object.defineProperty(globalThis, key, descriptors[key]!);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><Usage apiBase="http://usage-retention" /></LanguageProvider>);
  });
}

function payload(history?: object) {
  return {
    ...(history ? { history } : {}), range: "30d", surface: "all", since: null,
    sourceFilter: { client: "all", device: { kind: "all" } }, legacyUnclassifiedRequests: 0,
    generatedAt: Date.now(), summary: { requests: 0, measuredRequests: 0, reportedRequests: 0,
      unreportedRequests: 0, unsupportedRequests: 0, estimatedRequests: 0, inputTokens: 0,
      outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, coverageRatio: 0 },
    days: [], models: [], providers: [], historyTruncated: false, truncatedPrefixBytes: 0,
    entriesTruncated: false, entriesDropped: 0,
  };
}

test("recognizes only complete local reporting days", () => {
  expect(hasDailyPrecision("2026-10-01T00:00", "2026-10-01T23:59")).toBe(true);
  expect(hasDailyPrecision("2026-10-01T00:01", "2026-10-01T23:59")).toBe(false);
  expect(hasDailyPrecision("2026-10-01T00:00", "2026-10-01T12:00")).toBe(false);
});

test("requires daily precision only for bounds before the compaction boundary", () => {
  const history = { detailRetentionDays: 7, detailAvailableFrom: 100, historicalGranularity: "day" as const,
    historicalCostPolicy: "frozen" as const, timeZone: "UTC", compactedBefore: 200 };
  expect(requiresDailyPrecision(199, history)).toBe(true);
  expect(requiresDailyPrecision(200, history)).toBe(false);
  expect(requiresDailyPrecision(199)).toBe(false);
  expect(hasDailyPrecision("2026-10-01T00:00", "2026-11-06T12:00", { since: 100, until: 300 }, history)).toBe(true);
});

test("shows neutral history retention details only when the server provides metadata", async () => {
  await mount();
  request!.resolve(Response.json(payload({ detailRetentionDays: 7, detailAvailableFrom: Date.now() - 7 * 86400000,
    historicalGranularity: "day", historicalCostPolicy: "frozen", timeZone: "America/Sao_Paulo" })));
  await act(async () => {});
  const notice = host.querySelector('[role="status"].notice');
  expect(notice?.textContent).toBe(en["usage.historyRetention"].replace("{days}", "7"));
  expect(notice?.className).not.toContain("notice-err");
  expect(notice?.className).not.toContain("notice-warn");
});

test("keeps legacy servers free of history retention messaging", async () => {
  await mount();
  request!.resolve(Response.json(payload()));
  await act(async () => {});
  expect(host.textContent).not.toContain("Detailed usage is retained");
});
