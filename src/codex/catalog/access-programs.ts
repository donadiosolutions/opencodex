import { isMainCodexAccountTarget } from "../account-namespaces";
import { COMBO_NAMESPACE } from "../../combos";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";
import type { CodexModelEntitlementSnapshot, NativeRosterCapabilities } from "../model-entitlements";
import { clampAutoCompactTokenLimit } from "../../providers/auto-compact-budget";
import { trustedAccountBoundNativeCatalogSlug } from "./account-models";
import { BUILT_IN_NATIVE_OPENAI_MODELS } from "./native-models";
import {
  isNativeAliasCatalogEntry, NATIVE_OPENAI_CONTEXT_OVERRIDES, nativeOpenAiConfiguredContextLimit,
  narrowNativeOpenAiContextWindow, pinnedNativeCapabilityFlag, SUPPORTED_NATIVE_OPENAI_SLUGS, type NativeContextLimits,
} from "./metadata";
import { OPENAI_API_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import type { CodexUltrafastTier } from "./ultrafast-tier";
import type { RawEntry } from "./parsing";

function applyBuiltInCapabilities(
  entry: RawEntry, slug: string, roster: NativeRosterCapabilities | undefined, limits: NativeContextLimits,
  incoming: RawEntry = entry,
): void {
  if (!BUILT_IN_NATIVE_OPENAI_MODELS.includes(slug)) return;
  for (const flag of ["supports_reasoning_effort_updates", "supports_experimental_context"] as const) {
    const value = roster?.[flag] ?? pinnedNativeCapabilityFlag(slug, flag);
    if (value === undefined) delete entry[flag];
    else entry[flag] = value;
  }
  // The merge already applied pinned windows and user policy. Recompute only when
  // the confirmed account supplied a window; an omitted companion uses the pinned value.
  if (roster?.context_window === undefined && roster?.max_context_window === undefined) return;
  const fallback = NATIVE_OPENAI_CONTEXT_OVERRIDES[slug];
  const maximum = roster.max_context_window ?? fallback?.maxContextWindow;
  const defaultWindow = roster.context_window ?? fallback?.contextWindow;
  if (defaultWindow === undefined || maximum === undefined) return;
  const configured = nativeOpenAiConfiguredContextLimit(slug, limits);
  const window = Math.min(narrowNativeOpenAiContextWindow(defaultWindow, slug, limits) ?? defaultWindow, maximum);
  const retained = incoming.context_window === window ? incoming.auto_compact_token_limit : undefined;
  const budget = clampAutoCompactTokenLimit(window, fallback?.maxInputTokens, limits.modelAutoCompactTokenLimits?.[slug]);
  entry.context_window = window;
  entry.max_context_window = Math.min(configured ?? maximum, maximum);
  entry.auto_compact_token_limit = typeof retained === "number" && Number.isSafeInteger(retained) && retained > 0
    ? Math.min(retained, budget) : budget;
}

function nativeRosterTarget(
  entry: RawEntry, snapshot: CodexModelEntitlementSnapshot, accountTargets: ReadonlyMap<string, string>,
) {
  const accountBoundSlug = trustedAccountBoundNativeCatalogSlug(entry);
  const bareSlug = typeof entry.slug === "string" && SUPPORTED_NATIVE_OPENAI_SLUGS.has(entry.slug) ? entry.slug : undefined;
  const slug = accountBoundSlug ?? bareSlug;
  if (!slug) return;
  const selector = accountBoundSlug && typeof entry.slug === "string" ? entry.slug.slice(0, entry.slug.indexOf("/")) : undefined;
  const target = selector === undefined ? MAIN_CODEX_ACCOUNT_ID : accountTargets.get(selector);
  const accountId = target && isMainCodexAccountTarget(target) ? MAIN_CODEX_ACCOUNT_ID : target;
  const confirmedAccount = accountId && snapshot.confirmedAccountIds.has(accountId) && snapshot.modelsByAccount.get(accountId)?.has(slug)
    ? accountId : undefined;
  return { slug, bareSlug, confirmedAccount };
}

/** Used by both on-disk publication and read-only HTTP discovery. */
export function applyNativeRosterCapabilities(
  entries: RawEntry[], snapshot: CodexModelEntitlementSnapshot, accountTargets: ReadonlyMap<string, string>,
  limits: NativeContextLimits = {},
  incomingEntries: readonly RawEntry[] = entries,
): void {
  // The merge may temporarily replace a persisted roster window with a shipped
  // pin. Preserve lower policy only when the original and final windows match.
  const incomingBySlug = new Map<string, RawEntry>();
  for (const entry of incomingEntries) {
    if (typeof entry.slug !== "string" || isNativeAliasCatalogEntry(entry)
      || entry.owned_by === COMBO_NAMESPACE || incomingBySlug.has(entry.slug)) continue;
    // Match final slug deduplication: a later row cannot supply the retained budget.
    incomingBySlug.set(entry.slug, entry);
  }
  for (const entry of entries) {
    if (typeof entry.slug !== "string" || isNativeAliasCatalogEntry(entry) || entry.owned_by === COMBO_NAMESPACE) continue;
    const target = nativeRosterTarget(entry, snapshot, accountTargets);
    if (!target) continue;
    const capabilities = target.confirmedAccount ? snapshot.capabilitiesByAccount?.get(target.confirmedAccount)?.get(target.slug) : undefined;
    applyBuiltInCapabilities(entry, target.slug, capabilities, limits, incomingBySlug.get(entry.slug));
  }
}

/**
 * Project access programs per native account, and availability prompts only onto bare main rows.
 * Run after account-model metadata: this projection owns the final access-program value.
 */
export function applyNativeAccessPrograms(
  entries: RawEntry[], snapshot: CodexModelEntitlementSnapshot, accountTargets: ReadonlyMap<string, string>,
): void {
  for (const entry of entries) {
    // A combo may deliberately claim a bare native slug. It is still a routed combo row,
    // so the matching native Codex roster must not project its access programs onto it.
    if (isNativeAliasCatalogEntry(entry)) {
      delete entry.availability_nux;
      continue;
    }
    if (entry.owned_by === COMBO_NAMESPACE) {
      delete entry.available_access_programs;
      delete entry.availability_nux;
      continue;
    }
    const target = nativeRosterTarget(entry, snapshot, accountTargets);
    if (!target) continue;
    const { slug, bareSlug, confirmedAccount } = target;
    if (!bareSlug) delete entry.availability_nux;
    else {
      entry.availability_nux = confirmedAccount === MAIN_CODEX_ACCOUNT_ID
        ? snapshot.availabilityNuxByAccount?.get(confirmedAccount)?.get(slug) ?? null
        : null;
    }
    // An old on-disk catalog can contain metadata from a previous credential. Until this
    // account has a confirmed roster, that value is no longer evidence of a grant.
    if (!confirmedAccount) {
      delete entry.available_access_programs;
      continue;
    }
    const accountPrograms = snapshot.accessProgramsByAccount?.get(confirmedAccount);
    if (accountPrograms?.has(slug)) {
      entry.available_access_programs = accountPrograms.get(slug) ?? null;
    } else {
      delete entry.available_access_programs;
    }
  }
}

function removeUltrafastTier(entry: RawEntry): void {
  const tiers = entry.service_tiers;
  if (Array.isArray(tiers)) {
    const retained = tiers.filter(tier => (
      !tier || typeof tier !== "object" || !("id" in tier)
      || String((tier as { id?: unknown }).id).trim().toLowerCase() !== "ultrafast"
    ));
    if (retained.length > 0) entry.service_tiers = retained;
    else delete entry.service_tiers;
  }
  const speeds = entry.additional_speed_tiers;
  if (Array.isArray(speeds)) {
    const retained = speeds.filter(speed => (
      typeof speed !== "string" || speed.trim().toLowerCase() !== "ultrafast"
    ));
    if (retained.length > 0) entry.additional_speed_tiers = retained;
    else delete entry.additional_speed_tiers;
  }
  if (typeof entry.service_tier === "string" && entry.service_tier.trim().toLowerCase() === "ultrafast") {
    delete entry.service_tier;
  }
  if (typeof entry.default_service_tier === "string"
    && entry.default_service_tier.trim().toLowerCase() === "ultrafast") {
    delete entry.default_service_tier;
  }
}

function accountTierForNativeEntry(
  entry: RawEntry,
  accountTargets: ReadonlyMap<string, string>,
): { slug: string; accountId?: string } | undefined {
  const accountBoundSlug = trustedAccountBoundNativeCatalogSlug(entry);
  const bareOwnerAllowed = entry.owned_by === undefined || entry.owned_by === null
    || entry.owned_by === OPENAI_CODEX_PROVIDER_ID;
  const bareSlug = typeof entry.slug === "string" && !entry.slug.includes("/")
    && SUPPORTED_NATIVE_OPENAI_SLUGS.has(entry.slug) && bareOwnerAllowed ? entry.slug : undefined;
  const slug = accountBoundSlug ?? bareSlug;
  if (!slug) return undefined;
  const selector = accountBoundSlug && typeof entry.slug === "string"
    ? entry.slug.slice(0, entry.slug.indexOf("/")) : undefined;
  const target = selector === undefined ? MAIN_CODEX_ACCOUNT_ID : accountTargets.get(selector);
  return {
    slug,
    ...(target ? { accountId: isMainCodexAccountTarget(target) ? MAIN_CODEX_ACCOUNT_ID : target } : {}),
  };
}

/** Project authenticated Ultrafast declarations only onto the matching native account rows. */
export function applyNativeUltraFastTier(
  entries: RawEntry[],
  snapshot: CodexModelEntitlementSnapshot,
  accountTargets: ReadonlyMap<string, string>,
  enabled: boolean,
  bareEligibleAccountIds?: ReadonlySet<string>,
): void {
  for (const entry of entries) {
    const apiKeyNativeSlug = typeof entry.slug === "string"
      && entry.slug.startsWith(`${OPENAI_API_PROVIDER_ID}/`)
      ? entry.slug.slice(OPENAI_API_PROVIDER_ID.length + 1) : undefined;
    const apiKeyNative = apiKeyNativeSlug !== undefined
      && SUPPORTED_NATIVE_OPENAI_SLUGS.has(apiKeyNativeSlug);
    const nativeAlias = isNativeAliasCatalogEntry(entry);
    const combo = entry.owned_by === COMBO_NAMESPACE;
    const native = accountTierForNativeEntry(entry, accountTargets);
    if (apiKeyNative || nativeAlias || combo) {
      removeUltrafastTier(entry);
      continue;
    }
    if (!native) continue;

    // Ordinary and account-qualified native rows may retain stale template data. Routed provider
    // rows keep their operator-owned tier.
    removeUltrafastTier(entry);
    if (!enabled || !native.accountId) continue;

    const accountIds = trustedAccountBoundNativeCatalogSlug(entry) !== undefined
      ? [native.accountId]
      : [...snapshot.credentialIdentities.keys()].filter(id => !bareEligibleAccountIds || bareEligibleAccountIds.has(id));
    const tier: CodexUltrafastTier | undefined = accountIds.flatMap(accountId => (
      snapshot.confirmedAccountIds.has(accountId)
      && snapshot.modelsByAccount.get(accountId)?.has(native.slug)
        ? [snapshot.ultrafastTierByAccount?.get(accountId)?.get(native.slug)] : []
    )).find(value => value !== undefined);
    if (!tier) continue;

    const tiers = Array.isArray(entry.service_tiers) ? entry.service_tiers : [];
    entry.service_tiers = [...tiers, { ...tier }];
    const speeds = Array.isArray(entry.additional_speed_tiers) ? entry.additional_speed_tiers : [];
    entry.additional_speed_tiers = speeds.some(speed => (
      typeof speed === "string" && speed.trim().toLowerCase() === "ultrafast"
    )) ? speeds : [...speeds, "ultrafast"];
  }
}

export function applyNativeRosterMetadata(
  entries: RawEntry[], snapshot: CodexModelEntitlementSnapshot, accountTargets: ReadonlyMap<string, string>, limits: NativeContextLimits,
  incomingEntries?: readonly RawEntry[],
): void {
  applyNativeRosterCapabilities(entries, snapshot, accountTargets, limits, incomingEntries);
  applyNativeAccessPrograms(entries, snapshot, accountTargets);
}
