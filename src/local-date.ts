// "A day" means the user's local calendar day (system time zone by default).
// UTC ISO timestamps are sliced into local dates here instead of with slice(0, 10).

type DateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsOf(instant: Date, timeZone: string | undefined): DateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
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
  let result = guess - offsetMs(new Date(guess), timeZone);
  const recheck = guess - offsetMs(new Date(result), timeZone);
  if (recheck !== result) {
    result = recheck;
  }
  return new Date(result);
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
