import { boundedModelIdentity, knownModelIdentity } from "../lib/model-identity";

/** Served and resolved models on a row use the shared model-identity bound (src/lib/model-identity.ts). */
export function sanitizeServedModel(value: unknown): string | undefined {
  return boundedModelIdentity(value);
}

/** The identity fields that decide whether a response model is ocx's own echo. */
export interface ServedModelEchoSource {
  provider?: string;
  model?: string;
  wireModel?: string;
  requestedAlias?: string;
  requestedModel?: string;
  /** Client-facing selector this proxy wrote into `response.model` (Anthropic routes keep it). */
  responseModelEcho?: string;
}

/**
 * True when `served` is the client's own selector echoed back rather than a model the upstream
 * reported. Anthropic routes answer with the Codex-facing selector (`anthropic/claude-opus-5-5`),
 * and recording that as the served model painted every such row as rerouted. A value equal to
 * the wire model is never an echo. On adapter paths the upstream's real model is not observable
 * at all, so this only removes a false signal; passthrough `openai-model` observations are kept.
 */
export function isClientSelectorEcho(source: ServedModelEchoSource, served: string | undefined): boolean {
  if (served === undefined) return false;
  const wire = source.wireModel ?? source.model;
  if (served === wire) return false;
  return served === source.responseModelEcho
    || served === source.requestedAlias
    || served === source.requestedModel
    || (source.provider !== undefined && wire !== undefined && served === `${source.provider}/${wire}`);
}

/** Record a response-body model as the served model when it is a real upstream observation. */
export function recordObservedServedModel(
  target: ServedModelEchoSource & { servedModel?: string; resolvedModel?: string; preserveResolvedModelFromRoute?: boolean; attempts?: unknown },
  value: unknown,
): void {
  const servedModel = knownModelIdentity(value, routeKnownModels(target), target.provider);
  if (!servedModel || isClientSelectorEcho(target, servedModel)) return;
  target.servedModel = servedModel;
  if (!target.preserveResolvedModelFromRoute) target.resolvedModel = servedModel;
}

/**
 * Model ids a row's own route already names, which an upstream-reported served or resolved model
 * must equal to be recorded: the routed model (also without its provider prefix), the wire model,
 * the requested model and alias, and each attempt's target. The bundled Codex catalog is checked
 * by {@link knownModelIdentity} itself.
 */
export function routeKnownModels(source: ServedModelEchoSource & { attempts?: unknown }): string[] {
  const known: string[] = [];
  const add = (value: unknown) => { if (typeof value === "string" && value) known.push(value); };
  add(source.model);
  if (typeof source.model === "string" && source.model.includes("/")) add(source.model.slice(source.model.indexOf("/") + 1));
  add(source.wireModel);
  add(source.requestedModel);
  add(source.requestedAlias);
  if (Array.isArray(source.attempts)) {
    for (const attempt of source.attempts as unknown[]) {
      if (attempt && typeof attempt === "object") {
        add((attempt as { model?: unknown }).model);
        add((attempt as { wireModel?: unknown }).wireModel);
      }
    }
  }
  return known;
}

/**
 * Model identity fields for a log row. The served model is sanitized, and a resolvedModel that
 * only echoed a dropped served model is dropped with it, so the rejected value cannot survive
 * under the other name. A client-selector echo is dropped the same way, which also repairs
 * rows persisted before the echo was filtered at capture. Both are kept only when they equal a
 * model id the row's route already names (or the bundled catalog pins); see {@link knownModelIdentity}.
 */
export function modelIdentityLogFields(source: ServedModelEchoSource & { resolvedModel?: string; servedModel?: unknown; attempts?: unknown }): {
  resolvedModel?: string; servedModel?: string; wireModel?: string;
} {
  const known = routeKnownModels(source);
  const sanitized = knownModelIdentity(source.servedModel, known, source.provider);
  const servedModel = isClientSelectorEcho(source, sanitized) ? undefined : sanitized;
  // The resolved model passes the same validator on its own; it also leaves with a dropped served echo.
  const resolvedModel = source.servedModel !== undefined && source.resolvedModel === source.servedModel && !servedModel
    ? undefined : knownModelIdentity(source.resolvedModel, known, source.provider);
  return {
    ...(resolvedModel ? { resolvedModel } : {}),
    ...(servedModel ? { servedModel } : {}),
    ...(source.wireModel ? { wireModel: source.wireModel } : {}),
  };
}
