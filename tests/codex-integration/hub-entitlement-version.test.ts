import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { loadPersistedCodexRuntime } from "../../src/codex/runtime";
import {
  cachedCodexAccountEntitlements,
  ensureCodexEntitlementFreshness,
  getCodexModelEntitlementStatus,
  GATED_MODEL_CLIENT_VERSION_FLOOR,
  isUsableCodexClientVersion,
  resetCodexModelEntitlementCacheForTests,
  resolveCodexEntitlementClientVersion,
  resolveCodexModelEntitlements,
  type CodexEntitlementConfig,
  type CodexModelEntitlementCredentialSnapshot,
} from "../../src/codex/model-entitlements";
import { installIsolatedCodexHome } from "../helpers/isolated-codex-home";

const VERSION = "0.167.0";
const OLD_VERSION = "0.144.0";
const ACCOUNT = "hub-version-pool";
const MODEL = "gpt-6-astra";
const config: CodexEntitlementConfig = {
  runtimeRole: "hub", codexEntitlementClientVersion: VERSION,
  codexAccounts: [{ id: ACCOUNT, email: "hub@example.test", isMain: false }],
};
let isolated: ReturnType<typeof installIsolatedCodexHome>;
let previousHome: string | undefined;

function credential(): CodexModelEntitlementCredentialSnapshot {
  return {
    accountId: ACCOUNT, accessToken: "hub-token", chatgptAccountId: "hub-account",
    credentialIdentity: `pool:${readCodexAccountRecord(ACCOUNT)!.generation}:hub-account`,
  };
}

function roster(ultrafast: boolean): Response {
  return Response.json({ models: [{
    slug: MODEL, supported_in_api: true, visibility: "list",
    ...(ultrafast ? {
      service_tiers: [{ id: "ultrafast", name: "Ultrafast", description: "Higher speed" }],
      additional_speed_tiers: ["ultrafast"],
    } : {}),
  }] });
}

async function observe(clientVersion: string, now: number, ultrafast = true): Promise<void> {
  await resolveCodexModelEntitlements(config, {
    credentials: [credential()], clientVersion, now,
    fetcher: (async () => roster(ultrafast)) as typeof fetch,
  });
}

beforeEach(() => {
  isolated = installIsolatedCodexHome("ocx-hub-entitlement-version-");
  previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = isolated.path;
  resetCodexModelEntitlementCacheForTests();
  saveCodexAccountCredential(ACCOUNT, {
    accessToken: "hub-token", refreshToken: "hub-refresh", chatgptAccountId: "hub-account",
    expiresAt: Date.now() + 300_000,
  });
});
afterEach(() => {
  resetCodexModelEntitlementCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolated.restore();
});

test("Hub query version needs no CLI inventory and cannot replace an inbound version", () => {
  expect(loadPersistedCodexRuntime()).toBeNull();
  expect(resolveCodexEntitlementClientVersion(null, () => { throw new Error("must not read runtime"); }, { config }))
    .toBe(VERSION);
  expect(resolveCodexEntitlementClientVersion(OLD_VERSION, () => null, { config })).toBe(OLD_VERSION);
  expect(loadPersistedCodexRuntime()).toBeNull();
  expect(existsSync(join(isolated.path, "codex-runtime.json"))).toBe(false);
});

test("standalone and client ignore the Hub-only override and invalid versions fail validation", () => {
  for (const runtimeRole of [undefined, "standalone", "client"] as const) {
    expect(resolveCodexEntitlementClientVersion(null, () => ({ selectedVersion: "0.150.0" }), {
      config: { ...config, runtimeRole },
    })).toBe("0.150.0");
  }
  for (const value of ["", "0.0.0", "00.0.0-dev", "0.167.0\n?x=y", "0." + "1".repeat(64)]) {
    expect(isUsableCodexClientVersion(value)).toBe(false);
    expect(resolveCodexEntitlementClientVersion(null, () => null, {
      config: { ...config, codexEntitlementClientVersion: value },
    })).toBe(GATED_MODEL_CLIENT_VERSION_FLOOR);
  }
});

test("Hub freshness, status and trusted-version budget use the configured query version", async () => {
  const versions: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    versions.push(new URL(String(input)).searchParams.get("client_version")!);
    return roster(true);
  }) as typeof fetch;
  // Exhaust the allowance for caller-selected versions before the trusted Hub query runs.
  for (let i = 0; i < 4; i += 1) {
    await resolveCodexModelEntitlements(config, {
      credentials: [credential()], clientVersion: `0.${200 + i}.0`, now: 1_000, fetcher,
    });
  }
  await ensureCodexEntitlementFreshness(config, {
    now: 1_001, fetcher, credentialSnapshot: async accountId => accountId === ACCOUNT ? credential() : null,
  });
  expect(versions).toEqual(["0.200.0", "0.201.0", "0.202.0", "0.203.0", VERSION]);
  expect(getCodexModelEntitlementStatus(config, 1_002)).toEqual({ status: "fresh" });
  expect(cachedCodexAccountEntitlements(ACCOUNT, 1_002, VERSION)).toEqual(["ultrafast"]);
});

test("later old-version metadata and a hot new-version cache hit cannot mask Hub badges", async () => {
  await observe(VERSION, 1_000);
  await observe(OLD_VERSION, 2_000, false);
  expect(cachedCodexAccountEntitlements(ACCOUNT, 2_001)).toEqual([]);
  expect(cachedCodexAccountEntitlements(ACCOUNT, 2_001, OLD_VERSION)).toEqual([]);
  expect(cachedCodexAccountEntitlements(ACCOUNT, 2_001, VERSION)).toEqual(["ultrafast"]);
  const snapshot = await resolveCodexModelEntitlements(config, {
    credentials: [credential()], now: 2_002,
    fetcher: (async () => { throw new Error("hot Hub cache must not fetch"); }) as typeof fetch,
  });
  expect(snapshot.ultrafastTierByAccount?.get(ACCOUNT)?.has(MODEL)).toBe(true);
  expect(cachedCodexAccountEntitlements(ACCOUNT, 2_003, VERSION)).toEqual(["ultrafast"]);
  const old = await resolveCodexModelEntitlements(config, {
    credentials: [credential()], clientVersion: OLD_VERSION, now: 2_004,
    fetcher: (async () => { throw new Error("hot old cache must not fetch"); }) as typeof fetch,
  });
  expect(old.ultrafastTierByAccount?.get(ACCOUNT)?.has(MODEL)).toBe(false);
});

test("exact-version pills still drop expired, replaced and unconfirmed evidence", async () => {
  await observe(VERSION, 1_000);
  expect(cachedCodexAccountEntitlements(ACCOUNT, 301_000, VERSION)).toEqual([]);
  await resolveCodexModelEntitlements(config, {
    credentials: [credential()], now: 301_001,
    fetcher: (async () => new Response(null, { status: 503 })) as typeof fetch,
  });
  expect(cachedCodexAccountEntitlements(ACCOUNT, 301_002, VERSION)).toEqual([]);
  await observe(VERSION, 320_000);
  expect(cachedCodexAccountEntitlements(ACCOUNT, 320_001, VERSION)).toEqual(["ultrafast"]);
  saveCodexAccountCredential(ACCOUNT, {
    accessToken: "replacement", refreshToken: "replacement-refresh", chatgptAccountId: "hub-account",
    expiresAt: Date.now() + 300_000,
  });
  expect(cachedCodexAccountEntitlements(ACCOUNT, 320_002, VERSION)).toEqual([]);
  expect(cachedCodexAccountEntitlements(ACCOUNT, 320_002, "invalid")).toEqual([]);
});
