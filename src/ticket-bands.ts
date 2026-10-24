import type { ParkConfig } from "./config";
import { logPoll } from "./db";
import { readDigitickets, type DigiEvent } from "./digitickets";
import type { Env } from "./types";

/*
 * Ticket availability for parks whose stores publish a band, not numbers:
 * "Tickets available", "Limited", "Low", "Very low", "Sold out". DigiTickets
 * (Xtreme Scream Park, Tulleys) is the one source so far.
 *
 * Polled every 15 minutes, not every minute like accesso: reading the store's
 * calendar takes a basket in a fresh session each time (see digitickets.ts),
 * and a band moves slowly. Changes go to D1 (ticket_band_observation), the
 * history; the current picture goes to R2 at calendar/<park>/bands.json, which
 * the Calendar reads.
 */

export const BAND_LABELS = [
  "Sold out",
  "Very low availability",
  "Low availability",
  "Limited availability",
  "Tickets available",
] as const;

/** The store's phrase as a level, 0 (sold out) to 4. The phrase, not the CSS
 *  class: Tulleys sends "Low availability" with class "no-spaces". */
export function bandOf(phrase: string | null | undefined, className?: string | null): number | null {
  const p = (phrase ?? "").toLowerCase();
  if (/sold out|no (spaces|availability)|unavailable/.test(p)) return 0;
  if (/very low/.test(p)) return 1;
  if (/\blow\b/.test(p)) return 2;
  if (/limited/.test(p)) return 3;
  if (/available/.test(p)) return 4;
  const c = (className ?? "").toLowerCase();
  if (c === "no-spaces") return 0;
  if (c === "very-low-spaces") return 1;
  if (c === "low-spaces") return 2;
  if (c === "limited-spaces") return 3;
  if (c === "high-spaces") return 4;
  return null;
}

/** One night in the served file. */
export interface BandDay {
  /** The night's band: the store's own, or the best of its slots (can you still
   *  get in at all). */
  band: number;
  /** "From" price as the store shows it ("£39.75"). */
  price?: string;
  /** Timed arrival slots, [time, band], when the store sells them. */
  slots?: [string, number][];
  /** When we saw the night go to sold out. Absent if it was already sold out
   *  the first time we looked. */
  soldOutAt?: string;
  /** Every change to the night's band, [observed_at, band], oldest first. */
  history: [string, number][];
}

export interface BandsFile {
  park: string;
  generated_at: string;
  days: Record<string, BandDay>;
}

const bandsKey = (park: string) => `calendar/${park}/bands.json`;

/** A store event as a night: its band and slots. */
function toDay(e: DigiEvent): Omit<BandDay, "history" | "soldOutAt"> | null {
  const slots: [string, number][] = [];
  for (const s of e.sessions ?? []) {
    const b = bandOf(s.availabilityPhrase, s.className);
    if (s.time && b != null) slots.push([s.time, b]);
  }
  const own = bandOf(e.availabilityPhrase, e.availabilityClass);
  const band = own ?? (slots.length ? Math.max(...slots.map((s) => s[1])) : e.hasAvailability === false ? 0 : null);
  if (band == null) return null;
  return {
    band,
    ...(e.price ? { price: e.price } : {}),
    // A single evening session repeats the night's band; only real slots say more.
    ...(slots.length > 1 ? { slots } : {}),
  };
}

/** Poll one park's band source. Returns how many bands changed. */
export async function runBandsPoll(env: Env, park: ParkConfig): Promise<number> {
  const src = park.ticketBands;
  if (!src) return 0;
  const observedAt = new Date().toISOString();
  const read = await readDigitickets(src);
  if (!read.ok) {
    await logPoll(env.DB, park.key, "bands", read.httpStatus, "FAILED", 0, 0, observedAt);
    return 0;
  }

  let prev: BandsFile | null = null;
  const obj = await env.BUCKET.get(bandsKey(park.key));
  if (obj) {
    try {
      prev = (await obj.json()) as BandsFile;
    } catch {
      prev = null;
    }
  }
  // Dates the store no longer lists (past nights) keep their last state.
  const days: Record<string, BandDay> = { ...(prev?.days ?? {}) };
  const rows: { date: string; slot: string; band: number }[] = [];

  for (const e of read.events) {
    if (!e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;
    const now = toDay(e);
    if (!now) continue;
    const was = prev?.days[e.date];
    if (!was || was.band !== now.band) rows.push({ date: e.date, slot: "", band: now.band });
    const wasSlots = new Map(was?.slots ?? []);
    for (const [time, b] of now.slots ?? []) {
      if (wasSlots.get(time) !== b) rows.push({ date: e.date, slot: time, band: b });
    }
    const history = was?.history ?? [];
    days[e.date] = {
      ...now,
      ...(was?.soldOutAt ? { soldOutAt: was.soldOutAt } : {}),
      ...(was && was.band > 0 && now.band === 0 ? { soldOutAt: observedAt } : {}),
      history: !was || was.band !== now.band ? [...history, [observedAt, now.band]] : history,
    };
  }

  if (rows.length > 0) {
    // D1 caps bound parameters per statement, so insert a row at a time in one batch.
    await env.DB.batch(
      rows.map((r) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO ticket_band_observation (park, event_date, slot, band, observed_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(park.key, r.date, r.slot, r.band, observedAt),
      ),
    );
  }
  // Rewrite the file only when something moved, or the first time.
  if (rows.length > 0 || !prev) {
    const file: BandsFile = { park: park.key, generated_at: observedAt, days };
    await env.BUCKET.put(bandsKey(park.key), JSON.stringify(file), {
      httpMetadata: { contentType: "application/json" },
    });
  }
  await logPoll(env.DB, park.key, "bands", read.httpStatus, "OK", rows.length, read.events.length, observedAt);
  return rows.length;
}
