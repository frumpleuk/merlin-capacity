import { createContext, useContext } from "react";

// Park days, mirrored from src/config.ts (see the comment there). A park's day
// is its local date, running from DAY_ROLLOVER_HOUR to the same hour the next
// morning; times inside it are minutes since `${date}T00:00:00Z`.

export const DAY_ROLLOVER_HOUR = 4;

/** Exact UTC offset of `timeZone` at instant `ms`, in minutes (BST → 60). */
export function tzOffsetAt(ms: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(ms)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** The instant of local wall-clock `hour`:00 on `date` in `timeZone`. */
export function localInstant(date: string, hour: number, timeZone: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`) + hour * 3_600_000;
  const first = wall - tzOffsetAt(wall, timeZone) * 60_000;
  return wall - tzOffsetAt(first, timeZone) * 60_000;
}

/** The park day an instant belongs to. */
export function parkDay(ms: number, timeZone: string): string {
  const local = ms + tzOffsetAt(ms, timeZone) * 60_000 - DAY_ROLLOVER_HOUR * 3_600_000;
  return new Date(local).toISOString().slice(0, 10);
}

/** Where a park day ends, in minutes since `${date}T00:00:00Z` (1620 for a
 *  London summer day, 1680 in Orlando). */
export function parkDayEndMin(date: string, timeZone: string): number {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return (localInstant(next, DAY_ROLLOVER_HOUR, timeZone) - Date.parse(`${date}T00:00:00Z`)) / 60_000;
}

/** The park the page is showing: its zone, set once by Layout for every tab. */
export const ParkTimeZoneContext = createContext("Europe/London");

/** The local calendar date at instant `ms` in `timeZone` (midnight rollover). */
export function localDate(ms: number, timeZone: string): string {
  return new Date(ms + tzOffsetAt(ms, timeZone) * 60_000).toISOString().slice(0, 10);
}

/** Today's date at the park on the page, rolling over at local midnight. The
 *  calendars, heatmaps and Food tab use it rather than the UTC date, which is a
 *  day ahead in a US evening and a day behind in a Japanese morning, and rather
 *  than parkDay, whose 04:00 rollover only matters for queue days. */
export function useParkToday(): string {
  return localDate(Date.now(), useContext(ParkTimeZoneContext));
}
