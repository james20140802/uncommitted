// "A day" means the user's local calendar day (system time zone by default).
// UTC ISO timestamps are sliced into local dates here instead of with slice(0, 10).

type DateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

// One formatter per zone. The default zone is keyed by process.env.TZ so a
// runtime TZ change (as tests do) still picks up the new system zone.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? `system:${process.env.TZ ?? ""}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

function partsOf(instant: Date, timeZone: string | undefined): DateParts {
  const formatter = formatterFor(timeZone);
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0
  };
}

function formatDate(parts: DateParts): string {
  const pad = (value: number, width: number) => String(value).padStart(width, "0");
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}

function offsetMs(instant: Date, timeZone: string | undefined): number {
  const p = partsOf(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - wholeSeconds;
}

function localMidnight(year: number, month: number, day: number, timeZone: string | undefined): Date {
  const guess = Date.UTC(year, month - 1, day);
  // Re-read the offset at the first estimate so a DST change between UTC
  // midnight and local midnight is accounted for.
  const estimate = guess - offsetMs(new Date(guess), timeZone);
  const candidate = guess - offsetMs(new Date(estimate), timeZone);
  const target = formatDate({ year, month, day, hour: 0, minute: 0, second: 0 });
  const dateAt = (ms: number) => formatDate(partsOf(new Date(ms), timeZone));
  if (dateAt(candidate) === target) {
    return new Date(candidate);
  }
  // Local midnight was skipped by a DST jump, so the candidate landed in the
  // previous day. The day starts at the first instant after the jump, which
  // lies between the candidate and the pre-jump estimate.
  let before = candidate;
  let after = estimate;
  while (after - before > 1000) {
    const mid = before + Math.floor((after - before) / 2000) * 1000;
    if (dateAt(mid) >= target) {
      after = mid;
    } else {
      before = mid;
    }
  }
  return new Date(after);
}

export function localDateOf(isoTimestamp: string, timeZone?: string): string {
  const instant = new Date(isoTimestamp);
  if (Number.isNaN(instant.getTime())) {
    return isoTimestamp.slice(0, 10);
  }
  return formatDate(partsOf(instant, timeZone));
}

export function todayLocal(now: string | Date, timeZone?: string): string {
  if (now instanceof Date) {
    return formatDate(partsOf(now, timeZone));
  }
  return localDateOf(now, timeZone);
}

export function localDayWindow(date: string, timeZone?: string): { start: string; end: string } {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    start: localMidnight(year, month, day, timeZone).toISOString(),
    end: localMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone).toISOString()
  };
}
