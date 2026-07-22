import { USER_AGENT } from "./config";
import type { FetchResult } from "./merlin";
import type { DayObs, Snapshot } from "./types";

/**
 * Paulton's Park day-ticket availability. Independent of the accesso backend the
 * Merlin parks use (see merlin.ts): Paulton's publishes a single static JSON blob
 * at `tickets/availability.json` with one entry per on-sale date —
 *   { date, sold_out, suspended, availability: { total, available }, performances }
 * — served by plain nginx (no auth, no header gotchas). We map each day onto the
 * shared `Snapshot`/`DayObs` model (capacity = total, used = total − available),
 * so the whole downstream pipeline (diff → D1 delta log → month files → heatmap)
 * is reused byte-for-byte with the accesso products.
 *
 * `onSale` is deliberately left undefined: it exists for the Merlin parks'
 * prebook-only "yield anchor" dates (which the UI badges with a lock), a concept
 * Paulton's has no equivalent of. Undefined → the frontend treats the date as on
 * general sale, and `diffSnapshots` never sees a spurious sale-state flip.
 */
interface AvailBlob {
  days?: AvailDay[];
}
interface AvailDay {
  date?: string; // "2026-07-22T00:00:00+01:00"
  sold_out?: boolean;
  suspended?: boolean;
  availability?: { total?: number; available?: number };
}

export async function fetchPaultonsAvailability(
  url: string,
  startDate: string,
  endDate: string,
): Promise<FetchResult> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
  } catch {
    return { ok: false, httpStatus: 0, apiStatus: "FETCH_ERROR", snapshot: {}, datesSeen: 0 };
  }
  if (!resp.ok) {
    return { ok: false, httpStatus: resp.status, apiStatus: `HTTP_${resp.status}`, snapshot: {}, datesSeen: 0 };
  }

  let data: AvailBlob;
  try {
    data = (await resp.json()) as AvailBlob;
  } catch {
    return { ok: false, httpStatus: resp.status, apiStatus: "BAD_JSON", snapshot: {}, datesSeen: 0 };
  }
  if (!Array.isArray(data.days)) {
    return { ok: false, httpStatus: resp.status, apiStatus: "NO_DAYS", snapshot: {}, datesSeen: 0 };
  }

  const snapshot: Snapshot = {};
  for (const d of data.days) {
    // The `date` carries a local-midnight offset ("…+01:00"); its first 10 chars
    // are the calendar date we key on, matching the accesso `event_date` format.
    const iso = (d.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    // Clamp to the poll window so a long blob can't write dates outside it (keeps
    // parity with the accesso products' start/end-bounded fetch).
    if (iso < startDate || iso > endDate) continue;
    const total = Math.max(0, Number(d.availability?.total ?? 0));
    const available = Math.max(0, Number(d.availability?.available ?? 0));
    const obs: DayObs = {
      capacity: total,
      // A sold-out or suspended day has nothing left, whatever the blob says.
      available: d.sold_out || d.suspended ? 0 : Math.min(available, total),
      used: Math.max(0, total - available),
      packageIds: "",
    };
    snapshot[iso] = obs;
  }

  return {
    ok: true,
    httpStatus: resp.status,
    apiStatus: "OK",
    snapshot,
    datesSeen: Object.keys(snapshot).length,
  };
}
