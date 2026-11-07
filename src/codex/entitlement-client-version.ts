/** A version string upstream can filter on. Rejects empty and the `0.0.0` placeholder. */
export function isUsableCodexClientVersion(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "0.0.0") return false;
  // Bounded: the value reaches an outbound URL, and no real client version is this long.
  if (trimmed.length > 64) return false;
  if (!/^\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?$/.test(trimmed)) return false;
  // An all-zero numeric core is the same claim `0.0.0` makes — a client predating every gated
  // model — so `0`, `0.0`, `00.0.0`, and `0.0.0-dev` must fail for the same reason, by value
  // rather than by exact string.
  const core = trimmed.split(/[-+]/, 1)[0]!;
  if (core.split(".").every(segment => Number(segment) === 0)) return false;
  return true;
}
