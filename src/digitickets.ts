import { USER_AGENT } from "./config";

/* DigiTickets ticket stores (Xtreme Scream Park, Tulleys). Their availability
 * calendar is the source for both a park's opening hours (hours.ts) and its
 * ticket availability bands (ticket-bands.ts). See docs/digitickets.md. */

/** Where a park's store and event are. */
export interface DigiticketsConfig {
  /** The store's origin, e.g. https://twinlakes.digitickets.co.uk */
  store: string;
  /** The venue on a multi-venue store (`branches.branchID`); unset on a
   *  single-venue store (Tulleys). */
  branchId?: string;
  /** The ticket category the event lives under (`catID`). */
  catId: string;
  /** Months to read, the current one included. */
  months: number;
}

/** One session (an evening, or a timed arrival slot). */
export interface DigiSession {
  time?: string; // "18:30"
  endTime?: string; // "23:00"; equal to `time` for an arrival slot
  availabilityPhrase?: string | null;
  className?: string | null;
  hasHyperlink?: boolean;
}

/** One bookable date. */
export interface DigiEvent {
  date?: string; // "2026-10-24"
  hasAvailability?: boolean;
  availabilityPhrase?: string | null;
  availabilityClass?: string | null;
  price?: string | null; // "£41.20"
  sessions?: DigiSession[];
}

/**
 * Walk the store's booking flow far enough for its availability calendar to
 * answer: the store keeps the venue, event and basket in a session cookie and
 * redirects `/availability` back to `/tickets` without them. One ticket goes
 * into the basket; nothing is bought or held. Returns the session cookie, or
 * null if the store didn't play along.
 */
async function session(cfg: DigiticketsConfig): Promise<string | null> {
  const jar = new Map<string, string>();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const go = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const resp = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, cookie: cookie(), ...(init.headers ?? {}) },
    });
    for (const c of resp.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const at = pair.indexOf("=");
      if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
    return resp;
  };
  if (cfg.branchId) await go(`${cfg.store}/tickets?branches.branchID=${cfg.branchId}`);
  // The category redirects to its event page, which carries the form.
  let resp = await go(`${cfg.store}/category/${cfg.catId}`);
  for (let hop = 0; hop < 3 && resp.status >= 300 && resp.status < 400; hop++) {
    const to = resp.headers.get("location");
    if (!to) break;
    resp = await go(new URL(to, cfg.store).toString());
  }
  if (!resp.ok) return null;
  const page = await resp.text();
  const token = /name="csrf-token" value="([^"]+)"/.exec(page)?.[1];
  const ticket = /name="(tickets\[\d+\]\[qty\])"/.exec(page)?.[1];
  if (!token || !ticket) return null;
  const add = await go(`${cfg.store}/cart/add?catID=${cfg.catId}&date=`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ "csrf-token": token, [ticket]: "1" }).toString(),
  });
  return (add.headers.get("location") ?? "").includes("/availability") ? cookie() : null;
}

/** Every bookable date in the next `cfg.months` months, as the store lists them.
 *  All or nothing: a month that fails fails the read, so no caller writes a
 *  partial calendar. */
export async function readDigitickets(
  cfg: DigiticketsConfig,
): Promise<{ ok: true; httpStatus: number; events: DigiEvent[] } | { ok: false; httpStatus: number }> {
  let cookie: string | null;
  try {
    cookie = await session(cfg);
  } catch {
    cookie = null;
  }
  if (!cookie) return { ok: false, httpStatus: 0 };

  const now = new Date();
  const events: DigiEvent[] = [];
  let status = 0;
  for (let i = 0; i < cfg.months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const url =
      `${cfg.store}/availability?catID=${cfg.catId}&return=json` +
      `&year=${d.getUTCFullYear()}&month=${d.getUTCMonth() + 1}`;
    try {
      const resp = await fetch(url, {
        redirect: "manual",
        headers: {
          "user-agent": USER_AGENT,
          cookie,
          accept: "application/json",
          "x-requested-with": "XMLHttpRequest",
        },
      });
      status = resp.status;
      if (!resp.ok) return { ok: false, httpStatus: status };
      events.push(...(((await resp.json()) as { events?: DigiEvent[] }).events ?? []));
    } catch {
      return { ok: false, httpStatus: status };
    }
  }
  return { ok: true, httpStatus: status, events };
}
