import { getCombo, JEV_PROVIDER_ID, pickComboTarget, targetKey, type ComboPick, type JevCandidate } from "../../combos";
import { isCodexReasoningEffort } from "../../reasoning-effort";
import { routeConcreteModel } from "../../router";
import { supportedLadderFor } from "../effort-policy";
import type { OcxComboDefaultEffort, OcxConfig } from "../../types";

/** A JEV target's effort choices plus, when quota signals are on, its resolved native identity. */
export interface JevChoiceIdentity {
  reasoningEfforts: OcxComboDefaultEffort[];
  quotaIdentity?: JevCandidate["quotaIdentity"];
}

/** A target's JEV effort choices, or undefined when an explicit allowlist has none still supported. */
export function jevChoiceEfforts(
  config: OcxConfig,
  target: NonNullable<ReturnType<typeof getCombo>>["targets"][number],
  quotaSignals: boolean,
): JevChoiceIdentity | undefined {
  let ladder: string[] | undefined;
  // null tells the quota reader the route did not resolve, so it reads unknown rather than the configured alias.
  let quotaIdentity: JevCandidate["quotaIdentity"] = quotaSignals ? null : undefined;
  try {
    const route = routeConcreteModel(config, targetKey(target));
    ladder = supportedLadderFor({ provider: route.provider, modelId: route.modelId });
    if (quotaSignals) quotaIdentity = { provider: route.providerName, model: route.modelId };
  } catch {
    // Preserve the existing routing-failure surface. Unknown capability becomes the explicit
    // no-effort choice rather than broadening JEV's effort allowlist.
    ladder = undefined;
  }
  const supportedEfforts = (ladder ?? []).filter(isCodexReasoningEffort) as OcxComboDefaultEffort[];
  const configuredEfforts = target.reasoningEfforts;
  const reasoningEfforts = configuredEfforts === undefined
    ? supportedEfforts
    : configuredEfforts.filter(effort => supportedEfforts.includes(effort));
  // An explicit allowlist is restrictive. If catalog capabilities drift until no configured
  // effort remains supported, omit the target instead of silently broadening JEV's choices.
  return configuredEfforts !== undefined && reasoningEfforts.length === 0 ? undefined : { reasoningEfforts, quotaIdentity };
}

export interface JevComboChoice {
  pick: ComboPick;
  candidate: JevCandidate;
}

/** Enumerate this request's eligible targets without reserving another recovery pass. */
export function eligibleJevComboChoices(
  config: OcxConfig,
  comboId: string,
  eligible: (target: NonNullable<ReturnType<typeof getCombo>>["targets"][number]) => boolean,
  now: number,
  cooldownReprobeTargets?: ComboPick["cooldownReprobeTargets"],
): JevComboChoice[] {
  const combo = getCombo(config, comboId);
  if (!combo) return [];
  const excluded = new Set<string>();
  const choices: JevComboChoice[] = [];
  const reserved = cooldownReprobeTargets ? Object.entries(cooldownReprobeTargets) : undefined;
  while (excluded.size < combo.targets.length) {
    const pick = pickComboTarget(config, comboId, {
      exclude: excluded, eligible, now, allowCooldownReprobe: false, cooldownReprobeTargets: reserved,
    });
    if (!pick) break;
    const key = targetKey(pick.target);
    excluded.add(key);
    // The TypeSafe row owns a decision credential, not an inference transport.
    if (pick.target.provider === JEV_PROVIDER_ID) continue;
    const identity = jevChoiceEfforts(config, pick.target, combo.decisionQuotaSignals === true);
    if (!identity) continue;
    choices.push({
      pick: { ...pick, attempted: [key] },
      candidate: {
        key,
        provider: pick.target.provider,
        model: pick.target.model,
        ...identity,
        modelProfile: pick.target.modelProfile,
      },
    });
  }
  // #5691: the synchronous pick above does not defer emergency-only targets, so apply the
  // same rule here — withhold them from JEV while any normal target is offered, never when
  // they are all that remains.
  if (combo.cooldownWaitPolicy === "before-last-resort" && choices.some(choice => !choice.pick.target.lastResort)) {
    return choices.filter(choice => !choice.pick.target.lastResort);
  }
  return choices;
}
