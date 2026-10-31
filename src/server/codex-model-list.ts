import type { CodexModelEntitlementSnapshot } from "../codex/model-entitlements";
import { applyAccountModelMetadata } from "../codex/catalog/account-model-metadata";
import { applyNativeAccessPrograms, applyNativeUltraFastTier } from "../codex/catalog/access-programs";
import { websocketsEnabled } from "../config";
import type { OcxConfig } from "../types";
import { buildCatalogEntries } from "../codex/catalog/build-entries";
import { loadCatalogTemplate } from "../codex/catalog/bundled";
import { applyNativeVisibility, nativeContextLimits } from "../codex/catalog/metadata";
import { readCatalog, readCodexCatalogPath, type CatalogModel } from "../codex/catalog/parsing";
import { readNativeBaseline, retainedNativeSourcePriorities } from "../codex/catalog/native-priority";

interface CodexModelListInput {
  config: OcxConfig;
  nativeSlugs: string[];
  availableAccountNativeSlugs: string[];
  accountNativeSlugs: string[];
  accountNativeSlugsBySelector: ReadonlyMap<string, readonly string[]>;
  goOrdered: CatalogModel[];
  exactComboSlugs: ReadonlySet<string>;
  accountSelectors: string[];
  suppressedBareNativeSlugs: ReadonlySet<string>;
  disabledModels: ReadonlySet<string>;
  modelEntitlements?: CodexModelEntitlementSnapshot;
  accountTargets?: ReadonlyMap<string, string>;
  bareEligibleAccountIds?: ReadonlySet<string>;
}

/** Read-only Codex-shaped discovery; publication and backup creation belong to sync. */
export function buildCodexModelList({
  config, nativeSlugs, availableAccountNativeSlugs, accountNativeSlugs,
  accountNativeSlugsBySelector, goOrdered, exactComboSlugs, accountSelectors,
  suppressedBareNativeSlugs, disabledModels, modelEntitlements, accountTargets, bareEligibleAccountIds,
}: CodexModelListInput) {
  const catalogPath = readCodexCatalogPath();
  const nativeSource = {
    baseline: readNativeBaseline(catalogPath),
    retainedBySlug: retainedNativeSourcePriorities(readCatalog(catalogPath)?.models ?? []),
  };
  const maMode = config.multiAgentMode === "v1" || config.multiAgentMode === "v2" ? config.multiAgentMode : "default";
  // Account rows include hidden supported ids so newly re-enabled natives reappear before sync.
  const catalogNativeSlugs = accountSelectors.length > 0
    ? [...new Set([...availableAccountNativeSlugs, ...accountNativeSlugs])]
    : nativeSlugs;
  const entries = buildCatalogEntries(
    loadCatalogTemplate(), catalogNativeSlugs, goOrdered, config.subagentModels,
    websocketsEnabled(config), maMode, exactComboSlugs, accountSelectors,
    suppressedBareNativeSlugs, new Set(), nativeContextLimits(config), accountNativeSlugs,
    accountNativeSlugsBySelector, config.keepNativeChatGptOnV1 === true, config.modelPickerOrder,
    nativeSource,
  );
  if (modelEntitlements && accountTargets) {
    applyAccountModelMetadata(entries, modelEntitlements, accountTargets, bareEligibleAccountIds);
    applyNativeAccessPrograms(entries, modelEntitlements, accountTargets);
    applyNativeUltraFastTier(entries, modelEntitlements, accountTargets, config.ultraFastTier === true, bareEligibleAccountIds);
  }
  return { models: applyNativeVisibility(entries, disabledModels, accountSelectors.length > 0, new Set(accountNativeSlugs)) };
}
