import { baseProviderLabel } from "../providers/label";
import { createReportingCalendar, type ReportingCalendar } from "./reporting-calendar";
import type { PersistedUsageEntry } from "./log";
import { createUsageSummaryAccumulator, usageAttributions, type UsageSummaryAccumulator } from "./summary";
import { assertUsageSummarySnapshot, type NormalizedUsageFilter, type UsageSummarySnapshot } from "./summary-snapshot";

export type UsageAccountingFilter = { provider?: string | null; model?: string | null; apiKeyId?: string | null };
export function normalizeAccountingFilter(filter: UsageAccountingFilter = {}): NormalizedUsageFilter | null {
  const normalize = (value: string | null | undefined) => value?.trim().toLowerCase() || null;
  const normalized = { provider: normalize(filter.provider), model: normalize(filter.model), apiKeyId: filter.apiKeyId?.trim() || null };
  return normalized.provider === null && normalized.model === null && normalized.apiKeyId === null ? null : normalized;
}
export function accountingFilterKey(filter: UsageAccountingFilter | null = null): string {
  const normalized = normalizeAccountingFilter(filter ?? {});
  return JSON.stringify(normalized ? [normalized.provider, normalized.model, normalized.apiKeyId] : [null, null, null]);
}
export interface UsageKeyAccounting {
  configuredRequests: Record<string, number>;
  lastUsedAt: Record<string, number>;
  attributionSince: number | null;
}
export interface UsageRollupRecord {
  kind: "usage-rollup";
  version: 1;
  timeZone: string;
  compactedBefore: number;
  snapshot: UsageSummarySnapshot;
  /** Present once, on the all-provider/model/key cell for this partition. */
  keyUsage?: UsageKeyAccounting;
}
function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function numericMap(value: unknown, counts = false): value is Record<string, number> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).every(([key, value]) => key.length > 0 && number(value) && (!counts || Number.isSafeInteger(value)));
}
function isKeyAccounting(value: unknown): value is UsageKeyAccounting {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as UsageKeyAccounting;
  return Object.keys(v).length === 3 && numericMap(v.configuredRequests, true) && numericMap(v.lastUsedAt)
    && (v.attributionSince === null || number(v.attributionSince));
}
/** Ordinary rows return null; a malformed tagged rollup must fail closed. */
export function parseUsageRollupRecord(value: unknown): UsageRollupRecord | null {
  if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== "usage-rollup") return null;
  const record = value as UsageRollupRecord;
  if (record.version !== 1 || typeof record.timeZone !== "string" || !record.timeZone
    || !number(record.compactedBefore) || !Number.isSafeInteger(record.compactedBefore)
    || Object.keys(record).some(key => !["kind", "version", "timeZone", "compactedBefore", "snapshot", "keyUsage"].includes(key))) {
    throw new Error("Invalid or unsupported usage rollup");
  }
  try { new Intl.DateTimeFormat("en", { timeZone: record.timeZone }); }
  catch { throw new Error("Invalid usage rollup timezone"); }
  assertUsageSummarySnapshot(record.snapshot);
  if (record.snapshot.window || (record.keyUsage !== undefined
    && (record.snapshot.filter !== null || !isKeyAccounting(record.keyUsage)))) throw new Error("Invalid usage rollup metadata");
  if (record.snapshot.partitions.some(partition => partition.dayStart >= record.compactedBefore
    || (partition.oldestTimestamp !== null && partition.oldestTimestamp >= record.compactedBefore))) {
    throw new Error("Usage rollup contains uncompacted dates");
  }
  if (new Set(record.snapshot.partitions.map(partition => partition.dayStart)).size !== 1) throw new Error("Usage rollup must describe one reporting day");
  return record;
}
export function isUsageRollupRecord(value: unknown): value is UsageRollupRecord {
  try { return parseUsageRollupRecord(value) !== null; } catch { return false; }
}

interface Cell { accumulator: UsageSummaryAccumulator; keyUsage?: UsageKeyAccounting }
function emptyKeyUsage(): UsageKeyAccounting {
  return { configuredRequests: Object.create(null), lastUsedAt: Object.create(null), attributionSince: null };
}
function mergeKeyUsage(target: UsageKeyAccounting, source: UsageKeyAccounting): void {
  for (const [id, count] of Object.entries(source.configuredRequests)) target.configuredRequests[id] = (target.configuredRequests[id] ?? 0) + count;
  for (const [id, timestamp] of Object.entries(source.lastUsedAt)) target.lastUsedAt[id] = Math.max(target.lastUsedAt[id] ?? 0, timestamp);
  if (source.attributionSince !== null) target.attributionSince = target.attributionSince === null
    ? source.attributionSince : Math.min(target.attributionSince, source.attributionSince);
}

/** Observed filter cells preserve the summarizer's per-attempt combo projections. */
export class UsageRollupBuilder {
  private readonly cells = new Map<string, Cell>();
  private readonly calendar: ReportingCalendar;
  constructor(private readonly options: { timeZone: string; compactedBefore: number }) {
    this.calendar = createReportingCalendar(options.timeZone);
    if (!Number.isSafeInteger(options.compactedBefore) || options.compactedBefore < 0) throw new Error("Invalid usage compaction cutoff");
  }
  private cell(dayStart: number, filter: UsageAccountingFilter | null): Cell {
    const key = `${dayStart}:${accountingFilterKey(filter)}`;
    let cell = this.cells.get(key);
    if (!cell) {
      cell = { accumulator: createUsageSummaryAccumulator({ mode: "row-unique", timeZone: this.options.timeZone, ...(filter ? { filter } : {}) }),
        ...(normalizeAccountingFilter(filter ?? {}) === null ? { keyUsage: emptyKeyUsage() } : {}) };
      this.cells.set(key, cell);
    }
    return cell;
  }
  add(entry: PersistedUsageEntry): void {
    if (!Number.isSafeInteger(entry.timestamp) || entry.timestamp < 0 || entry.timestamp >= this.options.compactedBefore) throw new Error("Usage row is outside compaction bounds");
    const dayStart = this.calendar.startOfDay(entry.timestamp);
    const filters = new Map<string, UsageAccountingFilter | null>();
    const keys = entry.apiKeyId ? [null, entry.apiKeyId] : [null];
    for (const apiKeyId of keys) {
      const add = (filter: UsageAccountingFilter) => filters.set(accountingFilterKey(filter), normalizeAccountingFilter(filter));
      add({ apiKeyId });
      for (const attribution of usageAttributions(entry)) {
        const provider = baseProviderLabel(attribution.provider);
        const model = attribution.model;
        add({ apiKeyId, provider }); add({ apiKeyId, model }); add({ apiKeyId, provider, model });
      }
    }
    for (const filter of filters.values()) this.cell(dayStart, filter).accumulator.add(entry);
    const metadata = this.cell(dayStart, null).keyUsage!;
    if (entry.admissionKind) metadata.attributionSince = metadata.attributionSince === null
      ? entry.timestamp : Math.min(metadata.attributionSince, entry.timestamp);
    if (entry.admissionKind === "configured" && entry.apiKeyId) {
      metadata.configuredRequests[entry.apiKeyId] = (metadata.configuredRequests[entry.apiKeyId] ?? 0) + 1;
      metadata.lastUsedAt[entry.apiKeyId] = Math.max(metadata.lastUsedAt[entry.apiKeyId] ?? 0, entry.timestamp);
    }
  }
  addRollup(record: UsageRollupRecord): void {
    parseUsageRollupRecord(record);
    if (record.timeZone !== this.options.timeZone || record.compactedBefore > this.options.compactedBefore) throw new Error("Incompatible usage rollup");
    const first = record.snapshot.partitions[0];
    if (!first) throw new Error("Usage rollup has no daily partition");
    const cell = this.cell(first.dayStart, record.snapshot.filter);
    cell.accumulator.mergeSnapshot(record.snapshot);
    if (record.keyUsage) mergeKeyUsage(cell.keyUsage!, record.keyUsage);
  }
  finish(): UsageRollupRecord[] {
    const records: UsageRollupRecord[] = [];
    for (const { accumulator, keyUsage } of this.cells.values()) {
      const snapshot = accumulator.exportSnapshot();
      const record: UsageRollupRecord = { kind: "usage-rollup", version: 1, ...this.options, snapshot,
        ...(keyUsage ? { keyUsage: structuredClone(keyUsage) } : {}) };
      // Never publish an unreadable line. The caller can retain the original ledger on this rare limit.
      if (Buffer.byteLength(JSON.stringify(record)) >= 1_048_576) throw new Error("Usage rollup exceeds the accounting record limit");
      records.push(record);
    }
    return records;
  }
}
