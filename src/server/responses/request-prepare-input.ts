import type { HandleResponsesOptions, ResponsesRequestContext } from "./core-options";
import { observeLinkTurnExpansion } from "../link-turn";
import { markProxyError } from "../../lib/client-error-body";
import { parseSyntheticRowId } from "../fast-row";
import { responseTurnMembership } from "./turn-membership";
import { resolveSkillsSnapshotScopeKey, snapshotSkillsCatalogInBody } from "./skills-snapshot";
import { sanitizeEncryptedContentInPlace } from "./encrypted-payload";
import { previousResponseRestoredPrefixLength, markBodyNonPersistable, previousResponseProviderState } from "../../responses/state";
import { formatErrorResponse } from "../../bridge";
import type { OcxParsedRequest } from "../../types";
import { buildToolBridgeMaps } from "./collaboration";
import { parseRequest } from "../../responses/parser";
import { responsesHasFileImage, responsesHasInstructionImage } from "../../adapters/claude-cli/instruction-images";
import { anthropicSessionKeyFromParts } from "../../oauth/anthropic-routing";
import { isTranslatorBudgetExceededError } from "../../lib/translator-budget";
import { rebindCacheDiagnosticBody } from "../request-log";
import { resolveNativeReasoningRetention } from "../../config/schema/native-reasoning-retention";
import type { ClientToolCatalogRestriction } from "../../lib/empty-tool-catalog";
import { currentTurnWireToolCatalogBody, hasExplicitEmptyToolCatalog, collectDeclaredWireToolNames, collectTranslatedHostedToolNames, collectDeclaredBareCustomWireToolNames } from "../responses-undeclared-tool-guard";
import { recordContextTransformation } from "../transaction-capture";
import { eagerCodexToolCatalogSurface, warnEagerCodexToolCatalog } from "./codex-tool-catalog";
import { codexTurnStartsNewHistory } from "../../adapters/anthropic/per-message-effort";

/** Normalize expanded input and build the original client's tool and replay metadata. */
export function prepareResponsesInput(
  { options, req, config, logCtx }: Pick<ResponsesRequestContext, "options" | "config" | "req" | "logCtx">,
  body: unknown,
  scope: {
    inboundWire: NonNullable<HandleResponsesOptions["inboundWire"]>;
    concreteSelection: boolean;
    previousResponseInputExpanded: boolean;
    inboundOwnThreadId: string | undefined;
    inboundClientThreadId: string | undefined;
    cursorClientThreadId: string | undefined;
  },
) {
  const { inboundWire, concreteSelection, previousResponseInputExpanded, inboundOwnThreadId, inboundClientThreadId, cursorClientThreadId } = scope;
  const translatorBudget = options.translatorBudget;
  // Remote Link holds and request-log fields (design T4 sections 5, 9.1): the expanded input, before any upstream I/O.
  if (!options.comboReplaySnapshot) observeLinkTurnExpansion(options.linkTurn, req, logCtx, body, previousResponseInputExpanded ? "chained"
    : body && typeof body === "object" && typeof (body as { previous_response_id?: unknown }).previous_response_id === "string" ? "unexpanded" : "none");
  options.responsesInstructionImage ||= responsesHasInstructionImage(body);
  options.responsesFileImage ||= responsesHasFileImage(body);
  // Counted after replay expansion so the catalog this request pays for is the one measured:
  // input restored from stored continuation state is history, and the prefix removes it.
  if (inboundWire === "responses" && !concreteSelection) {
    warnEagerCodexToolCatalog(body, req.headers, {
      surface: eagerCodexToolCatalogSurface(body, options.compactionRecoveryKind),
      replayPrefixLength: previousResponseRestoredPrefixLength(body),
      logicalRequest: logCtx,
    });
  }

  // Convert plaintext task payloads before parsing for both translated and native requests.
  // Preserve recognized ciphertext and let final routing decide what to do with unknown slots.
  {
    const rewritten = sanitizeEncryptedContentInPlace(
      (body as { input?: unknown } | undefined)?.input,
      // The final destination is not known yet. Keep ambiguous encoded slots opaque until route
      // selection can either strip them for a third party or apply strict native classification.
      { preserveUnknownOpaqueSlots: true },
    );
    if (rewritten > 0) {
      recordContextTransformation(logCtx, { kind: "plaintext_encrypted_rewrite" });
    }
    if (rewritten > 0)
      console.warn(
        `[opencodex] rewrote ${rewritten} plaintext encrypted_content part(s) to input_text (spawn-message compatibility)`,
      );
  }

  const skillsSnapshotScopeKey = resolveSkillsSnapshotScopeKey({
    req,
    config,
    admission: options.admission,
    promptCacheKeyIsSharedCohort: options.promptCacheKeyIsSharedCohort,
  });
  // Substitutes a known snapshot now; a new catalog is only stored once the request is prepared.
  const commitSkillsSnapshot = snapshotSkillsCatalogInBody(body, skillsSnapshotScopeKey, config);

  const turnMembership = responseTurnMembership(req, config, options.admission);
  if (turnMembership && body && typeof body === "object" && "input" in body && Array.isArray(body.input)) {
    body.input = turnMembership.normalize(body.input);
  }

  let parsed: OcxParsedRequest;
  let toolBridgeMaps: ReturnType<typeof buildToolBridgeMaps>;
  let clientToolCatalogRestriction: ClientToolCatalogRestriction | undefined;
  try {
    parsed = parseRequest(body);
    // Antigravity direct lane: the body carried only the request settings, so the parse above
    // produced them with an empty conversation; the conversation itself comes straight from the
    // client body. Inside this try so a decode error answers exactly like a parse error.
    if (options.directRequest) parsed = options.directRequest.decode(parsed);
    parsed._nativeReasoningRetention = resolveNativeReasoningRetention(config);
    // Capture before route rewrites or hosted sidecars can add tools; replayed catalogs are history.
    // Direct decoders already own current function names (including legacy Chat functions).
    // Project only those names; bridging the conversation would retain its reasoning twice.
    const catalogBody = options.directRequest && parsed.context.tools?.length
      ? { tools: parsed.context.tools.map(tool => ({ type: "function", name: tool.name })) } : parsed._rawBody;
    const currentCatalog = currentTurnWireToolCatalogBody(catalogBody, parsed._replayPrefixLen);
    // A hosted tool declared this turn authorizes the function name its translation uses.
    const translatedHostedNames = collectTranslatedHostedToolNames(currentCatalog);
    clientToolCatalogRestriction = {
      declaredToolNames: new Set([...collectDeclaredWireToolNames(currentCatalog), ...translatedHostedNames]),
      bareCustomToolNames: collectDeclaredBareCustomWireToolNames(currentCatalog),
      canonicalToolNames: new Set([...collectDeclaredWireToolNames(currentCatalog, { canonicalOnly: true }), ...translatedHostedNames]),
      // Ordinary Responses validation stays with its delivery owner; replay cannot add authority.
      enforceDeclaredToolNames: (inboundWire === "responses" && (parsed._replayPrefixLen ?? 0) > 0)
        || options.clientDeclaredEmptyToolCatalog === true
        || hasExplicitEmptyToolCatalog(currentCatalog),
    };
    if (options.inboundWire === "anthropic") {
      parsed._nativeReasoningReplay = options.nativeReasoningReplay;
      parsed._nativeReasoningMint = options.nativeReasoningMint;
      parsed._anthropicServerTools = options.anthropicServerTools;
      // The lowered named choice serves the wire builder but grants no client or synthetic tool permission.
      if (options.anthropicHostedAdvisorSelection) {
        parsed.options.explicitRootFunctionChoices = [];
        parsed.options.explicitClientToolChoices = [];
      }
      parsed._anthropicServerReplay = options.anthropicServerReplay;
      parsed._anthropicSystemCachePrefix = options.anthropicSystemCachePrefix;
      parsed._anthropicInbound = true;
      if (parsed.options.textFormat?.type === "json_schema") parsed._structuredOutputConformance = true;
    }
    if (options.advisorInternal || options.internalSidecarCall || options.internalDecisionCall) {
      parsed._proxyOwnedSystemPrompt = true;
    }
    // Codex's own "new" turn metadata, for the experimental Anthropic perMessageEffort option (#6895).
    parsed._codexNewHistory = codexTurnStartsNewHistory(body, req.headers,
      options.inboundTransport === "websocket" ? "websocket" : undefined);
    parsed._promptCacheKeyIsSharedCohort = options.promptCacheKeyIsSharedCohort;
    // The body may have been rebuilt since the inbound observation (previous-response
    // expansion); alias the parsed raw body to the same draft so the outbound
    // observation at the adapter seam still finds it.
    rebindCacheDiagnosticBody(parsed._rawBody, logCtx.cacheDiagnosticDraft);
    // Captured before any parser mutates it, so both grammars see the client's id.
    const { fastRow, effortRow } = parseSyntheticRowId(parsed.modelId, config);
    if (fastRow) {
      parsed.modelId = fastRow.baseId;
      parsed.options.serviceTier = "priority";
      const raw = parsed._rawBody as Record<string, unknown>;
      raw.model = fastRow.baseId;
      raw.service_tier = "priority";
    }
    if (effortRow) {
      parsed.modelId = effortRow.baseId;
      parsed.options.reasoning = effortRow.effort;
      const raw = parsed._rawBody as Record<string, unknown>;
      const rawReasoning = raw.reasoning;
      raw.model = effortRow.baseId;
      raw.reasoning = {
        ...(rawReasoning && typeof rawReasoning === "object" && !Array.isArray(rawReasoning)
          ? rawReasoning as Record<string, unknown>
          : {}),
        effort: effortRow.effort,
      };
    }
    if (options.comboReplaySnapshot?.recoveredPlaintext) {
      markBodyNonPersistable(parsed._rawBody);
    }
    toolBridgeMaps = buildToolBridgeMaps(parsed, translatorBudget);
    if (previousResponseInputExpanded) parsed._previousResponseInputExpanded = true;
    const providerContinuationCandidate = options.comboReplaySnapshot
      ? options.comboReplaySnapshot.providerContinuation
      : previousResponseProviderState(parsed.previousResponseId);
    if (providerContinuationCandidate) parsed._providerContinuationCandidate = providerContinuationCandidate;
    if (inboundOwnThreadId) parsed._codexOwnThreadId = inboundOwnThreadId;
    if (inboundClientThreadId) {
      parsed._clientThreadId = inboundClientThreadId;
    } else if (
      options.inboundWire === "anthropic"
      && options.promptCacheKeyIsSharedCohort !== true
      && typeof parsed.options.promptCacheKey === "string"
      && parsed.options.promptCacheKey.trim().length > 0
    ) {
      // Claude Code has no Codex parent-thread header, but its metadata.user_id is
      // translated into a stable per-session prompt_cache_key. Use it as the replay
      // thread identity so Gemini thought signatures are remembered by call_id for
      // Anthropic Messages clients too (#1735/#1926). Keep `_clientThreadId` unset so
      // existing provider session-id derivation (first-user-text fallback) is unchanged.
      // Normalize through anthropicSessionKeyFromParts so overlong keys are hashed and
      // trimming matches the affinity/session-key path exactly (no raw >128-char ids).
      const normalizedCacheKey = anthropicSessionKeyFromParts({
        promptCacheKey: parsed.options.promptCacheKey,
        // The enclosing branch already proves this is not the shared cohort.
        promptCacheKeyIsSharedCohort: false,
      });
      if (normalizedCacheKey) {
        parsed._reasoningReplayScope = { clientThreadId: normalizedCacheKey };
      }
    }
    if (cursorClientThreadId) parsed._cursorClientThreadId = cursorClientThreadId;
    if (options.shadowCallIntercepted === true) parsed._cursorIsolateConversation = true;
    if (options.memoryModelPhase !== undefined) {
      parsed._memoryModelPhase = options.memoryModelPhase;
      parsed._cursorIsolateConversation = true;
    }
  } catch (err) {
    if (isTranslatorBudgetExceededError(err)) {
      return markProxyError(formatErrorResponse(413, "request_too_large", "request translation buffer exceeded the safe limit", {
        code: "translation_buffer_limit",
      }));
    }
    return formatErrorResponse(400, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }
  return { parsed, clientToolCatalogRestriction, commitSkillsSnapshot, toolBridgeMaps, turnMembership };
}
