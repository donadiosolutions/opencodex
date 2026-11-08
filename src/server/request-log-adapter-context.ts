import type { AdapterRequest } from "../adapters/base";
import type { RequestLogContext } from "./request-log";
import { captureSafely, recordContextTransformation } from "./transaction-capture";

const contextObservationOwners = new WeakMap<RequestLogContext, WeakSet<AdapterRequest>>();

/** Copy adapter-owned bounded observations without retaining the built request. */
export function recordAdapterContext(logCtx: RequestLogContext, request: AdapterRequest): void {
  captureSafely(() => {
    let seen = contextObservationOwners.get(logCtx);
    if (!seen) { seen = new WeakSet(); contextObservationOwners.set(logCtx, seen); }
    if (seen.has(request)) return;
    seen.add(request);
    if (!Array.isArray(request.contextLog)) return;
    for (const observation of request.contextLog.slice(0, 16)) recordContextTransformation(logCtx, observation);
  });
}
