import * as z from "zod/v4";
import { isUsableCodexClientVersion } from "../../codex/entitlement-client-version";

export const codexEntitlementClientVersionSchema = z.string().refine(isUsableCodexClientVersion);

export function codexEntitlementClientVersionError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.codexEntitlementClientVersion === undefined) return null;
  if (!codexEntitlementClientVersionSchema.safeParse(raw.codexEntitlementClientVersion).success) {
    return "schema_invalid: codexEntitlementClientVersion: expected a bounded nonzero Codex version";
  }
  return raw.runtimeRole === "hub" ? null
    : "schema_invalid: codexEntitlementClientVersion: requires runtimeRole hub";
}
