import { markProtocolEntry, protocolMarkFeatures } from "../../protocols/trace";
import type { PolicyRequestEvidence } from "../../routing/evaluator";
import { evidenceFromBody } from "../../routing/request-evidence";
import type { RouteResult } from "../../router";
import type { OcxParsedRequest } from "../../types";
import { isAntigravityRoute } from "../antigravity-direct-eligibility";
import type { RequestLogContext } from "../request-log";
import type { HandleResponsesOptions } from "./core-options";

/** Policy-routing evidence. The direct lane's settings-only body has no conversation to scan. */
export function routeEvidence(options: Pick<HandleResponsesOptions, "directRequest">, parsed: OcxParsedRequest): PolicyRequestEvidence {
  return options.directRequest?.evidence ?? evidenceFromBody(parsed._rawBody);
}

/**
 * Leave the Antigravity direct lane for this request: put the bridge conversation back on the
 * Responses body so every `_rawBody` reader sees what the bridge would have sent, and trace the
 * request as the bridge. The IR conversation already decoded stays: it equals what
 * `parseRequest` builds from the restored body (`tests/protocols/chat-ir-parity.test.ts`).
 */
export function restoreDirectRequestConversation(options: HandleResponsesOptions, body: unknown, logCtx: RequestLogContext): void {
  const direct = options.directRequest;
  if (!direct) return;
  options.directRequest = undefined;
  if (body && typeof body === "object" && !Array.isArray(body)) Object.assign(body, direct.bridgeConversation());
  if (options.clientEncoder) options.clientEncoder = { ...options.clientEncoder, requestLane: "bridge" };
  markProtocolEntry(logCtx, {
    inbound: direct.protocol,
    lane: "bridge",
    reasonCodes: ["not-migrated"],
    features: protocolMarkFeatures(logCtx) ?? [],
  });
}

/**
 * Leave the direct lane as soon as the route stops being the Antigravity route it was decided
 * for. Called after every route assignment, so readers that run between a reroute and dispatch
 * (canonical sanitization, ciphertext stripping, final normalization) see the bridge body.
 */
export function leaveDirectLaneIfRerouted(
  options: HandleResponsesOptions,
  route: Pick<RouteResult, "providerName" | "modelId" | "provider">,
  parsed: OcxParsedRequest,
  logCtx: RequestLogContext,
): void {
  const direct = options.directRequest;
  if (!direct) return;
  if (route.providerName === direct.providerName && route.modelId === direct.modelId && isAntigravityRoute(route)) return;
  restoreDirectRequestConversation(options, parsed._rawBody, logCtx);
}
