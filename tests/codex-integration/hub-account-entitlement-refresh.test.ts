import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCodexAuthAccounts } from "../../src/codex/auth-api/account-list";
import { readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { resetCodexModelEntitlementCacheForTests, resolveCodexModelEntitlements, type CodexModelEntitlementCredentialSnapshot } from "../../src/codex/model-entitlements";
import { runPassiveRead } from "../../src/lib/passive-read";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ACCOUNT = "hub-account-refresh-pool";
const VERSION = "0.167.0";
const OLD_VERSION = "0.144.0";
let isolatedCodexHome: IsolatedCodexHome;
let stateDir: string;
let previousOpenCodexHome: string | undefined;
let previousFetch: typeof fetch;
let modelStatus: number;
let modelRequests: string[];

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {},
    runtimeRole: "hub",
    codexEntitlementClientVersion: VERSION,
    codexAccounts: [{ id: ACCOUNT, email: "hub@example.test", isMain: false }],
  };
}

function credentialSnapshot(): CodexModelEntitlementCredentialSnapshot {
  const record = readCodexAccountRecord(ACCOUNT)!;
  return {
    accountId: ACCOUNT,
    accessToken: record.credential!.accessToken,
    chatgptAccountId: record.credential!.chatgptAccountId!,
    credentialIdentity: `pool:${record.generation}:${record.credential!.chatgptAccountId}`,
  };
}

function roster(ultrafast: boolean): Response {
  return Response.json({ models: [{
    slug: "gpt-6-astra",
    supported_in_api: true,
    visibility: "list",
    ...(ultrafast ? {
      service_tiers: [{ id: "ultrafast", name: "Ultrafast", description: "Higher speed" }],
      additional_speed_tiers: ["ultrafast"],
    } : {}),
  }] });
}

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-hub-account-entitlement-refresh-");
  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  previousFetch = globalThis.fetch;
  stateDir = mkdtempSync(join(tmpdir(), "ocx-hub-account-refresh-state-"));
  process.env.OPENCODEX_HOME = stateDir;
  mkdirSync(join(stateDir, "codex"), { recursive: true });
  modelStatus = 200;
  modelRequests = [];
  resetCodexModelEntitlementCacheForTests();
  saveCodexAccountCredential(ACCOUNT, {
    accessToken: "hub-pool-token",
    refreshToken: "hub-pool-refresh",
    chatgptAccountId: "hub-chatgpt-account",
    expiresAt: Date.now() + 300_000,
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/backend-api/codex/models") {
      modelRequests.push(url.searchParams.get("client_version") ?? "");
      return modelStatus === 200 ? roster(true) : new Response("unavailable", { status: modelStatus });
    }
    if (url.pathname.endsWith("/wham/usage")) return Response.json({});
    throw new Error(`unexpected fixture request: ${url.pathname}`);
  }) as typeof fetch;
});

afterEach(() => {
  resetCodexModelEntitlementCacheForTests();
  globalThis.fetch = previousFetch;
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  isolatedCodexHome.restore();
  removeTreeWithRetry(stateDir);
});

test("active Hub account list refreshes the configured version and keeps its badge after old-version noise", async () => {
  const cfg = config();
  const first = (await listCodexAuthAccounts(cfg, true)).find(row => row.id === ACCOUNT)!;
  expect(first.entitlements).toEqual(["ultrafast"]);
  expect(modelRequests).toEqual([VERSION]);

  await resolveCodexModelEntitlements(cfg, {
    credentials: [credentialSnapshot()],
    clientVersion: OLD_VERSION,
    now: Date.now() + 1,
    fetcher: (async () => roster(false)) as typeof fetch,
  });
  const afterOldVersion = (await listCodexAuthAccounts(cfg)).find(row => row.id === ACCOUNT)!;
  expect(afterOldVersion.entitlements).toEqual(["ultrafast"]);
  expect(modelRequests).toEqual([VERSION]);
});

test("passive account list does not start entitlement network refresh", async () => {
  const rows = await runPassiveRead(() => listCodexAuthAccounts(config()));
  expect(rows.find(row => row.id === ACCOUNT)?.entitlements).toEqual([]);
  expect(modelRequests).toEqual([]);
});

test("a failed entitlement refresh stays fail closed in the account DTO", async () => {
  const cfg = config();
  modelStatus = 503;
  const failed = (await listCodexAuthAccounts(cfg, true)).find(row => row.id === ACCOUNT)!;
  expect(failed.hasCredential).toBe(true);
  expect(failed.entitlements).toEqual([]);
  expect(modelRequests).toEqual([VERSION]);
});

test("replacing a credential drops its prior account-list badge when refresh fails", async () => {
  const cfg = config();
  const warmed = (await listCodexAuthAccounts(cfg, true)).find(row => row.id === ACCOUNT)!;
  expect(warmed.entitlements).toEqual(["ultrafast"]);

  saveCodexAccountCredential(ACCOUNT, {
    accessToken: "replacement-token",
    refreshToken: "replacement-refresh",
    chatgptAccountId: "replacement-chatgpt-account",
    expiresAt: Date.now() + 300_000,
  });
  modelStatus = 503;
  const replaced = (await listCodexAuthAccounts(cfg, true)).find(row => row.id === ACCOUNT)!;
  expect(replaced.hasCredential).toBe(true);
  expect(replaced.entitlements).toEqual([]);
  expect(modelRequests).toEqual([VERSION, VERSION]);
});
