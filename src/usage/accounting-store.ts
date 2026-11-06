/** Rebuildable accounting-only projection. Canonical detail never lives here. */
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, openSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { currentUsageLogRevision, usageLogIdentityKey, usageLogPath, usageLogRevisionKey, type PersistedUsageEntry, type UsageLogRevision } from "./log";
import { scanUsageLedgerCooperatively, UsageLedgerRebuildRequiredError, type UsageLedgerScanResult } from "./ledger-scanner";
import { projectUsageAccountingEntry } from "./accounting-entry";
import { accountingFilterKey, parseUsageRollupRecord, type UsageAccountingFilter, type UsageRollupRecord } from "./rollup";
import { createUsageSummaryAccumulator, type UsageSummaryAccumulator } from "./summary";
import { usageHistoryMetadata, type UsageHistoryMetadata } from "./retention-contract";
import type { UsageTimeWindow } from "./time-range";
import { userCostOverlayVersion } from "./user-cost-overlays";

interface Checkpoint extends UsageLedgerScanResult {}
interface Store { path: string; db: Database; checkpoint: Checkpoint | null }
let active: Store | null = null;
let refreshFlight: Promise<Store> | null = null;
const reports = new Map<string, UsageAccountingResult>();
const reportFlights = new Set<Promise<unknown>>();
let operationTail: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation, operation);
  operationTail = result.catch(() => {});
  return result;
}

export interface UsageAccountingResult {
  accumulator: UsageSummaryAccumulator;
  usageIncomplete: boolean;
  revision: UsageLogRevision | null;
  processedThroughBytes: number;
  overlayVersion: number;
  timeZone: string;
  update: "unchanged" | "append" | "rebuild";
  history: UsageHistoryMetadata;
}

export class HistoricalUsagePrecisionError extends Error {
  readonly code = "historical_daily_precision_required";
  constructor(readonly history: UsageHistoryMetadata) { super("Historical usage requires whole reporting-day boundaries"); }
}

export function hasCompactedUsageLedger(): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(usageLogPath(), "r");
    const buffer = Buffer.alloc(256);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return /"kind"\s*:\s*"usage-rollup"/.test(buffer.toString("utf8", 0, length));
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Header-only scheduling hint; accounting still validates the complete record. */
export function lastUsageCompactionBoundary(): number | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(usageLogPath(), "r");
    const header = Buffer.alloc(512);
    const length = readSync(fd, header, 0, header.length, 0);
    const text = header.toString("utf8", 0, length);
    if (!/"kind"\s*:\s*"usage-rollup"/.test(text)) return undefined;
    const raw = text.match(/"compactedBefore"\s*:\s*(\d+)/)?.[1];
    return raw ? Number(raw) : undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function closeUsageAccountingStore(): void {
  active?.db.close();
  active = null;
  reports.clear();
}

export async function drainUsageAccountingStore(): Promise<void> {
  try { await refreshFlight; } catch { /* An invalidated scan is discarded. */ }
  await Promise.allSettled([...reportFlights]);
  await operationTail;
  closeUsageAccountingStore();
}

function openStore(): Store {
  const path = join(getConfigDir(), "usage-accounting.sqlite");
  if (active?.path === path) return active;
  closeUsageAccountingStore();
  recordOwnedConfigPath(getConfigDir(), path);
  let db: Database | undefined;
  try {
    db = new Database(path);
    const checked = db.query("PRAGMA quick_check").get() as { quick_check: string };
    if (checked.quick_check !== "ok") throw new Error("invalid accounting index");
  } catch {
    db?.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(path + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    db = new Database(path);
  }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS accounting_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounting_entries (offset INTEGER PRIMARY KEY, timestamp REAL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS accounting_timestamp ON accounting_entries(timestamp);
    CREATE TABLE IF NOT EXISTS accounting_rollups (offset INTEGER PRIMARY KEY, filter TEXT NOT NULL, payload TEXT NOT NULL);`);
  for (const suffix of ["", "-wal", "-shm"]) {
    try { chmodSync(path + suffix, 0o600); } catch { /* Windows ACL owns permissions. */ }
  }
  const saved = db.query("SELECT value FROM accounting_meta WHERE key='checkpoint-v1'").get() as { value: string } | null;
  let checkpoint: Checkpoint | null = null;
  try {
    if (saved) {
      const candidate = JSON.parse(saved.value) as Checkpoint;
      if (Number.isSafeInteger(candidate.processedThroughBytes) && candidate.processedThroughBytes >= 0
        && typeof candidate.processedThroughDigest === "string" && /^[a-f0-9]{64}$/.test(candidate.processedThroughDigest)
        && Number.isSafeInteger(candidate.oversizedRows) && candidate.oversizedRows >= 0
        && (candidate.revision === null || (candidate.revision?.path === usageLogPath()
          && Number.isSafeInteger(candidate.revision.size) && candidate.revision.size >= candidate.processedThroughBytes))) checkpoint = candidate;
    }
  } catch { /* rebuild */ }
  active = { path, db, checkpoint };
  return active;
}

async function refreshStore(): Promise<Store> {
  const store = openStore();
  const observed = currentUsageLogRevision();
  const previous = store.checkpoint;
  if (previous && usageLogRevisionKey(previous.revision) === usageLogRevisionKey(observed)
    && previous.revision?.size === observed?.size) return store;
  const append = previous?.revision && observed && observed.size > previous.revision.size
    && usageLogIdentityKey(previous.revision) === usageLogIdentityKey(observed);
  const db = store.db;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!append) db.exec("DELETE FROM accounting_entries; DELETE FROM accounting_rollups;");
    let sequence = append ? previous.processedThroughBytes : 0;
    const insertEntry = db.prepare("INSERT INTO accounting_entries(offset,timestamp,payload) VALUES(?,?,?)");
    const insertRollup = db.prepare("INSERT INTO accounting_rollups(offset,filter,payload) VALUES(?,?,?)");
    const scan = await scanUsageLedgerCooperatively({
      strictAccounting: hasCompactedUsageLedger(),
      ...(append ? { startAtBytes: previous.processedThroughBytes, expectedIdentityKey: usageLogIdentityKey(previous.revision), expectedProcessedThroughDigest: previous.processedThroughDigest } : {}),
      onRecord(value) {
        if (!value || typeof value !== "object" || !("kind" in value) || value.kind !== "usage-rollup") return false;
        const record = parseUsageRollupRecord(value)!;
        insertRollup.run(++sequence, accountingFilterKey(record.snapshot.filter ?? {}), JSON.stringify(record));
        return true;
      },
      onEntry(entry) { insertEntry.run(++sequence, entry.timestamp, JSON.stringify(projectUsageAccountingEntry(entry))); },
    });
    const checkpoint = { ...scan, oversizedRows: scan.oversizedRows + (append ? previous.oversizedRows : 0) };
    db.query("INSERT OR REPLACE INTO accounting_meta VALUES('checkpoint-v1',?)").run(JSON.stringify(checkpoint));
    db.exec("COMMIT");
    if (!append) {
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* A reader can defer WAL reclamation. */ }
    }
    store.checkpoint = checkpoint;
    reports.clear();
    return store;
  } catch (error) {
    db.exec("ROLLBACK");
    if (append && error instanceof UsageLedgerRebuildRequiredError) {
      store.checkpoint = null;
      return refreshStore();
    }
    throw error;
  }
}

async function refreshShared(): Promise<Store> {
  if (refreshFlight) return refreshFlight;
  refreshFlight = refreshStore();
  try { return await refreshFlight; }
  finally { refreshFlight = null; }
}

export function refreshUsageAccountingStore(): Promise<Store> {
  return serialize(refreshShared);
}

function dayBoundary(timestamp: number, timeZone: string, end: boolean): boolean {
  const adjusted = end ? timestamp + 1 : timestamp;
  if (adjusted % 1000 !== 0) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(adjusted);
  return parts === "00:00:00";
}

async function readUsageAccountingInner(options: { now?: number; filter?: UsageAccountingFilter; window?: UsageTimeWindow } = {}): Promise<UsageAccountingResult> {
  const before = openStore().checkpoint;
  const store = await refreshShared();
  const checkpoint = store.checkpoint!;
  const now = options.now ?? Date.now();
  const filter = options.filter ?? {};
  const key = JSON.stringify([accountingFilterKey(filter), options.window, userCostOverlayVersion(), Math.floor(now / 60_000)]);
  const cached = reports.get(key);
  if (cached) return { ...cached, update: "unchanged" };
  let compactedBefore: number | undefined;
  let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const firstRollup = store.db.query("SELECT payload FROM accounting_rollups ORDER BY offset LIMIT 1").get() as { payload: string } | null;
  if (firstRollup) {
    const metadata = parseUsageRollupRecord(JSON.parse(firstRollup.payload))!;
    timeZone = metadata.timeZone;
    compactedBefore = metadata.compactedBefore;
  }
  const accumulator = createUsageSummaryAccumulator({ mode: "row-unique", filter, window: options.window, timeZone });
  const records = store.db.query("SELECT payload FROM accounting_rollups WHERE filter=? ORDER BY offset").all(accountingFilterKey(filter)) as Array<{ payload: string }>;
  for (const row of records) {
    const record = parseUsageRollupRecord(JSON.parse(row.payload))!;
    compactedBefore = Math.max(compactedBefore ?? 0, record.compactedBefore);
    timeZone = record.timeZone;
    if (!options.window || options.window.since < record.compactedBefore) accumulator.mergeSnapshot(record.snapshot);
  }
  const history = usageHistoryMetadata(now, compactedBefore, timeZone);
  const window = options.window;
  if (window && compactedBefore !== undefined
    && ((window.since < compactedBefore && !dayBoundary(window.since, timeZone, false))
      || (window.until < compactedBefore && !dayBoundary(window.until, timeZone, true)))) throw new HistoricalUsagePrecisionError(history);
  const rows = window
    ? store.db.query("SELECT payload FROM accounting_entries WHERE timestamp>=? AND timestamp<=? ORDER BY offset").iterate(window.since, window.until)
    : store.db.query("SELECT payload FROM accounting_entries ORDER BY offset").iterate();
  let count = 0;
  for (const row of rows) {
    accumulator.add(JSON.parse((row as { payload: string }).payload) as PersistedUsageEntry);
    if (++count % 1000 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  const result: UsageAccountingResult = {
    accumulator, history, timeZone, overlayVersion: userCostOverlayVersion(),
    revision: checkpoint.revision, processedThroughBytes: checkpoint.processedThroughBytes,
    usageIncomplete: checkpoint.oversizedRows > 0,
    update: before === checkpoint ? "unchanged" : before ? "append" : "rebuild",
  };
  if (reports.size >= 8) reports.delete(reports.keys().next().value!);
  reports.set(key, result);
  return result;
}

export function readUsageAccounting(options: { now?: number; filter?: UsageAccountingFilter; window?: UsageTimeWindow } = {}): Promise<UsageAccountingResult> {
  const flight = serialize(() => readUsageAccountingInner(options));
  reportFlights.add(flight);
  void flight.finally(() => reportFlights.delete(flight)).catch(() => {});
  return flight;
}

async function readRecentAccountingEntriesInner(since: number): Promise<PersistedUsageEntry[]> {
  const store = await refreshShared();
  return (store.db.query("SELECT payload FROM accounting_entries WHERE timestamp>=? ORDER BY offset").all(since) as Array<{ payload: string }>)
    .map(row => JSON.parse(row.payload) as PersistedUsageEntry);
}

export function readRecentAccountingEntries(since: number): Promise<PersistedUsageEntry[]> {
  return serialize(() => readRecentAccountingEntriesInner(since));
}

async function readAccountingKeyUsageInner(ids: string[], now = Date.now()): Promise<{ rollup: Map<string, { ambiguous?: boolean; requests7d?: number; totalRequests?: number; lastUsedAt?: string }>; attributionSince?: string }> {
  const store = await refreshShared();
  const { createApiKeyUsageAccumulator } = await import("../server/management/api-key-usage");
  const accumulator = createApiKeyUsageAccumulator(ids, now);
  for (const row of store.db.query("SELECT payload FROM accounting_entries").iterate()) accumulator.add(JSON.parse((row as { payload: string }).payload));
  const result = accumulator.snapshot();
  let attributionSince = result.attributionSince ? Date.parse(result.attributionSince) : Infinity;
  for (const row of store.db.query("SELECT payload FROM accounting_rollups WHERE filter=?").iterate(accountingFilterKey({}))) {
    const record: UsageRollupRecord = parseUsageRollupRecord(JSON.parse((row as { payload: string }).payload))!;
    if (!record.keyUsage) continue;
    if (record.keyUsage.attributionSince !== null) attributionSince = Math.min(attributionSince, record.keyUsage.attributionSince);
    for (const id of ids) {
      const value = result.rollup.get(id);
      if (!value || value.ambiguous) continue;
      value.totalRequests += Object.hasOwn(record.keyUsage.configuredRequests, id) ? record.keyUsage.configuredRequests[id]! : 0;
      const last = Object.hasOwn(record.keyUsage.lastUsedAt, id) ? record.keyUsage.lastUsedAt[id] : undefined;
      if (last !== undefined && (!value.lastUsedAt || last > Date.parse(value.lastUsedAt))) value.lastUsedAt = new Date(last).toISOString();
    }
  }
  return { ...result, ...(Number.isFinite(attributionSince) ? { attributionSince: new Date(attributionSince).toISOString() } : {}) };
}

export function readAccountingKeyUsage(ids: string[], now = Date.now()): ReturnType<typeof readAccountingKeyUsageInner> {
  return serialize(() => readAccountingKeyUsageInner(ids, now));
}
