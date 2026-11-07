/** Calendar operations for an explicitly retained reporting zone, or the host default. */
export interface ReportingCalendar {
  readonly estimatedBytes: number;
  dateKey(timestamp: number): string;
  startOfDay(timestamp: number): number;
  shiftDay(timestamp: number, days: number): number;
}

const DAY_MS = 86_400_000;
const MAX_CACHED_DAYS = 512;

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function createReportingCalendar(timeZone?: string): ReportingCalendar {
  if (timeZone === undefined) return {
    estimatedBytes: 0,
    dateKey: localDateKey,
    startOfDay(timestamp) {
      const date = new Date(timestamp);
      date.setHours(0, 0, 0, 0);
      return date.getTime();
    },
    shiftDay(timestamp, days) {
      const date = new Date(timestamp);
      date.setDate(date.getDate() + days);
      return date.getTime();
    },
  };

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const midnights = new Map<string, number>();
  function dateFromKey(key: string): Date {
    const [year, month, day] = key.split("-").map(Number);
    const date = new Date(0);
    date.setUTCFullYear(year!, month! - 1, day!);
    return date;
  }
  function utcDateKey(date: Date): string {
    return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }
  function fields(timestamp: number): Record<string, string> {
    return Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]));
  }
  function dateKey(timestamp: number): string {
    if (!Number.isFinite(timestamp)) return localDateKey(timestamp);
    const parts = fields(timestamp);
    return `${parts.year!.padStart(4, "0")}-${parts.month}-${parts.day}`;
  }
  function offset(timestamp: number): number {
    const parts = fields(timestamp);
    const wall = new Date(0);
    wall.setUTCFullYear(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    wall.setUTCHours(Number(parts.hour), Number(parts.minute), Number(parts.second), 0);
    return wall.getTime() - Math.floor(timestamp / 1000) * 1000;
  }
  function midnight(key: string): number {
    const cached = midnights.get(key);
    if (cached !== undefined) return cached;
    const wall = dateFromKey(key).getTime();
    if (!Number.isFinite(wall)) return NaN;
    // Sample both sides of an offset transition. A repeated midnight chooses
    // its first occurrence, just as Date's local calendar operations do.
    const candidates = [...new Set([offset(wall - DAY_MS), offset(wall), offset(wall + DAY_MS)])]
      .map(zoneOffset => wall - zoneOffset)
      .filter(candidate => candidate + offset(candidate) === wall);
    let result = Math.min(...candidates);
    if (!Number.isFinite(result)) {
      // A midnight gap (or a skipped civil date) starts at the first existing
      // instant of that date or its successor. Binary search handles both.
      let low = wall - 2 * DAY_MS;
      let high = wall + 2 * DAY_MS;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (dateFromKey(dateKey(middle)).getTime() < wall) low = middle + 1;
        else high = middle;
      }
      result = low;
    }
    if (midnights.size >= MAX_CACHED_DAYS) midnights.delete(midnights.keys().next().value!);
    midnights.set(key, result);
    return result;
  }
  let cachedDay: { key: string; start: number; end: number } | undefined;
  function day(timestamp: number): { key: string; start: number; end: number } {
    if (cachedDay && timestamp >= cachedDay.start && timestamp < cachedDay.end) return cachedDay;
    const key = dateKey(timestamp);
    const next = dateFromKey(key);
    next.setUTCDate(next.getUTCDate() + 1);
    return cachedDay = { key, start: midnight(key), end: midnight(utcDateKey(next)) };
  }
  return {
    get estimatedBytes() { return 2_048 + midnights.size * 128; },
    dateKey: timestamp => day(timestamp).key,
    startOfDay: timestamp => day(timestamp).start,
    shiftDay(timestamp, days) {
      const date = dateFromKey(day(timestamp).key);
      date.setUTCDate(date.getUTCDate() + days);
      return midnight(utcDateKey(date));
    },
  };
}
