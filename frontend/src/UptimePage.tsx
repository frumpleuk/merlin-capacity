import { Fragment, useEffect, useMemo, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import {
  loadUptime,
  OUTAGE_BINS,
  type DailyPoint,
  type GroupDim,
  type UptimeFile,
  type RideStats,
  type WindowStats,
} from "./api";
import { findPark, PARK_HOME } from "./catalog";
import { useMediaQuery } from "./useMediaQuery";

/* ── Ride uptime ──────────────────────────────────────────────────────────
 *
 * Twenty-odd rides is past the point where colour can carry identity, so the
 * ranking is a TABLE with one meter per row rather than a chart with a legend.
 * The meter is a single-hue magnitude encoding — more filled is more available —
 * and the number sits beside it, so the bar is never read alone.
 *
 * One hero figure: the park's own availability. Everything else is a stat tile,
 * a table cell, or a small chart inside an expanded row.
 */

const WINDOWS = [
  { key: "d7", label: "7 days", days: 7 },
  { key: "d14", label: "14 days", days: 14 },
  { key: "d28", label: "28 days", days: 28 },
  { key: "d60", label: "60 days", days: 60 },
  { key: "d90", label: "90 days", days: 90 },
] as const;

/** Every column sorts. `get` returns null for "no value", which always sorts
 *  last whichever way the column points: a ride that never stopped has no
 *  median stoppage length, and floating it to the top of "shortest first" would
 *  read as the best rather than the absent. */
const COLUMNS: {
  key: string;
  label: string;
  title?: string;
  /** Direction on first click — the interesting end of that column. */
  desc: boolean;
  /** Dropped on narrow screens. */
  wide?: boolean;
  get: (r: RideStats) => number | string | null;
}[] = [
  { key: "name", label: "Ride", desc: false, get: (r) => r.name.toLowerCase() },
  { key: "availability", label: "Available", desc: false, get: (r) => r.availability },
  {
    key: "outages_per_day",
    label: "Stops/day",
    title: "Stoppages per day it ran",
    desc: true,
    get: (r) => r.outages_per_day,
  },
  {
    key: "outage_median",
    label: "Median",
    title: "Median length of a stoppage",
    desc: true,
    get: (r) => r.outage_median,
  },
  {
    key: "outage_p90",
    label: "p90",
    title: "One stoppage in ten lasts at least this",
    desc: true,
    get: (r) => r.outage_p90,
  },
  {
    key: "minutes_between_outages",
    label: "Between stops",
    title: "Mean operating time between stoppages (MTBF). Park hours only.",
    desc: false,
    wide: true,
    get: (r) => r.minutes_between_outages,
  },
  {
    key: "clean_days",
    label: "Clear days",
    title: "Days it ran with no stoppage",
    desc: false,
    wide: true,
    get: (r) => r.clean_days,
  },
];

/** A ride needs a reasonable share of the window behind it before its numbers
 *  mean anything. Without this the ranking leads with a ride that appeared for
 *  one day and was shut on it — 0% available, technically true, useless. They
 *  are hidden rather than dropped: the toggle says how many, and shows them. */
const wellMeasured = (r: RideStats, windowDays: number): boolean =>
  r.days - r.closed_days >= Math.max(3, windowDays / 4);

/** Fewest days before a 10th-percentile day means anything. Nearest-rank over
 *  six values picks the first one, so on a 7-day window "worst day in ten" is
 *  just the worst day — Rush reads 0.0% off a single closure. Availability
 *  itself is fine at any window: it is a ratio of MINUTES, and 0.1% is 2.6
 *  minutes over a 7-day window against a measurement resolved to the minute. */
const MIN_DAYS_FOR_P10 = 10;

/** Fewest stoppages that make a histogram worth drawing. Below this the shape
 *  is three bars of one, which looks like a distribution and is a coincidence.
 *  The survival curve needs more still (the backend's own floor), so a window
 *  can have enough for the shape and not enough for the odds. */
const MIN_FOR_SHAPE = 8;

/** Sentinel for the ungrouped view — a flat ranking across the whole park. */
const NO_GROUP = "__none__";

/** Which axes this park can be grouped on. A park with a single `group` per
 *  ride (most of them) gets one unnamed axis; Paulton's declares thrill and
 *  area. Either way the last option is always "None". */
function groupOptions(data: UptimeFile, rides: RideStats[]): GroupDim[] {
  if (data.groupDims?.length) return data.groupDims;
  return rides.some((r) => r.group) ? [{ key: "group", label: "Group", by: "thrill" }] : [];
}

const groupOf = (r: RideStats, dim: string): string | null =>
  dim === "group" ? (r.group ?? null) : (r.groups?.[dim] ?? null);

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const pct = (x: number | null | undefined, dp = 0): string =>
  x == null ? "—" : `${(x * 100).toFixed(dp)}%`;

const mins = (x: number | null | undefined): string => (x == null ? "—" : `${Math.round(x)}m`);

/** Some catalogs append an advisory to the name — Thorpe's Ready Player One is
 *  "… | Age Rating 12A". Useful in the park, noise in a ranking. */
const rideName = (n: string): string => n.split("|")[0].trim();

/** Running time between stoppages. Past one operating day it is quoted in DAYS:
 *  a park open eight hours that manages "24h between stops" has run for three
 *  days, and the hours figure invites reading it as one. */
function betweenStops(x: number | null | undefined, openDay: number): string {
  if (x == null) return "—";
  const m = Math.round(x);
  if (openDay > 0 && m >= openDay) {
    const d = m / openDay;
    return `${d < 10 ? d.toFixed(1) : Math.round(d)} days`;
  }
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

/** The magnitude meter: fill is the value, track is a lighter step of the same
 *  hue. No border between them — the track IS the remainder. */
function Meter({ value, title }: { value: number | null; title: string }) {
  return (
    <span className="rl-meter" title={title} role="img" aria-label={title}>
      <span className="rl-meter-track">
        <span
          className="rl-meter-fill"
          style={{ width: `${Math.max(0, Math.min(1, value ?? 0)) * 100}%` }}
        />
      </span>
      <span className="rl-meter-num">{pct(value, 1)}</span>
    </span>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rl-tile">
      <div className="rl-tile-label">{label}</div>
      <div className="rl-tile-value">{value}</div>
      {note && <div className="rl-tile-note">{note}</div>}
    </div>
  );
}

/**
 * The shape behind the median. Two rides can share a median of 17 minutes and
 * look nothing alike — one with every stoppage clustered there, another with
 * half of them short and a tail past two hours — and the median alone hides it.
 *
 * Bins are fixed across every ride and park, so shapes compare by eye.
 */
function Histogram({ bins, label }: { bins: number[]; label: string }) {
  const total = bins.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const max = Math.max(...bins);
  const e = OUTAGE_BINS;
  const name = (i: number) =>
    i === 0
      ? `under ${e[0]}m`
      : i === bins.length - 1
        ? `over ${e[e.length - 1]}m`
        : `${e[i - 1]}–${e[i]}m`;
  return (
    <div
      className="rl-hist"
      role="img"
      aria-label={`${label}: ${bins.map((n, i) => `${name(i)} ${n}`).join(", ")}`}
    >
      {bins.map((n, i) => (
        <div className="rl-hist-col" key={i} title={`${name(i)} — ${n} of ${total}`}>
          <div className="rl-hist-bar-wrap">
            <div className="rl-hist-bar" style={{ height: `${max > 0 ? (n / max) * 100 : 0}%` }} />
          </div>
          <div className="rl-hist-tick">
            {i === bins.length - 1 ? `${e[e.length - 1]}+` : e[i]}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * How each day compared with a typical one.
 *
 * Plotting availability itself needs an axis, and there is no honest one: every
 * value sits between about 85% and 100%, so a zero baseline flattens the lot
 * and a truncated baseline turns a 1.15x difference into a tenfold-looking bar.
 * A line dodged that and said nothing — 26 points inside 15 percentage points
 * is a flat squiggle.
 *
 * So plot the DEVIATION from the window's median instead. Zero is then a real
 * zero — the typical day — bar length is honestly proportional to how far from
 * typical a day was, and the question the strip exists to answer ("was that day
 * bad, or is it always like this?") is the one it now reads out directly.
 */
function DayStrip({ daily, from }: { daily: DailyPoint[]; from: string }) {
  const vals = daily.map((d) => d.availability).filter((x): x is number => x != null);
  if (vals.length < 3) return null;
  // Only days the park opened have a rollup, so the series skips the rest. Left
  // as-is the axis silently compresses — Paulton's seven-day window drew five
  // columns between two dates a week apart, with nothing to say two days were
  // missing. Pad the calendar span so a closed day is a visible gap.
  const slots: (DailyPoint | null)[] = [];
  const byDate = new Map(daily.map((d) => [d.date, d]));
  // From the window's start, not the first day with data: a park shut at the
  // beginning of the window would otherwise have those days trimmed away
  // rather than shown as closed.
  for (
    let t = Date.parse(`${from}T00:00:00Z`);
    t <= Date.parse(`${daily[daily.length - 1].date}T00:00:00Z`);
    t += 86_400_000
  ) {
    slots.push(byDate.get(new Date(t).toISOString().slice(0, 10)) ?? null);
  }
  const mid = median(vals) ?? 0;
  // Symmetric, so a point above and a point below the median are the same
  // length for the same size of difference.
  const span = Math.max(...vals.map((v) => Math.abs(v - mid)), 0.005);
  const pts = (v: number) => (v - mid) * 100;
  return (
    <div className="rl-strip-wrap">
      <div className="rl-strip-head">
        <span className="rl-strip-title">How each day compared</span>
        <span className="rl-strip-scale">
          vs the median day ({pct(mid, 1)}) · {daily.length} open
          {slots.length > daily.length ? ` of ${slots.length}` : ""}
        </span>
      </div>
      <div className="rl-strip" role="img" aria-label={`Each day's availability against the median of ${pct(mid, 1)}`}>
        {slots.map((d, i) => {
          if (!d) {
            return (
              <div className="rl-strip-col rl-strip-shut" key={`shut-${i}`} title="Park closed" />
            );
          }
          const dev = d.availability == null ? 0 : pts(d.availability);
          const h = Math.min(50, (Math.abs(dev) / (span * 100)) * 50);
          return (
            <div
              className="rl-strip-col"
              key={d.date}
              title={`${d.date} — ${pct(d.availability, 1)} available (${
                dev >= 0 ? "+" : ""
              }${dev.toFixed(1)} vs median), ${d.outages} stoppages${
                d.closed_rides ? `, ${d.closed_rides} not running` : ""
              }${d.partial ? " · part day, we started watching late" : ""}`}
            >
              <span
                className={"rl-strip-bar" + (dev < 0 ? " below" : "")}
                style={{ height: `${h}%`, [dev < 0 ? "top" : "bottom"]: "50%" }}
              />
            </div>
          );
        })}
      </div>
      <div className="rl-strip-axis">
        <span>{from}</span>
        <span>{daily[daily.length - 1].date}</span>
      </div>
    </div>
  );
}

/** The expanded row: how long this ride's stoppages run, and what that means
 *  for someone standing in its queue. */
function Detail({ r }: { r: RideStats }) {
  const s = r.outage_survival;
  return (
    <div className="rl-detail-grid">
      <div>
        {s ? (
          <>
            <h4 className="rl-detail-h">Back within</h4>
            <table className="rl-survival">
              <tbody>
                {[
                  { t: "15 min", v: s.resume_within_15 },
                  { t: "30 min", v: s.resume_within_30 },
                  { t: "60 min", v: s.resume_within_60 },
                ].map((b) => (
                  <tr key={b.t}>
                    <th scope="row">{b.t}</th>
                    <td>
                      <Meter value={b.v} title={`${pct(b.v)} cleared within ${b.t}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h4 className="rl-detail-h">Still down after</h4>
            <table className="rl-cond">
              <thead>
                <tr>
                  <th scope="col">Still down at</th>
                  <th scope="col">How often</th>
                  <th scope="col">Lasted another</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { t: 15, n: s.n_past_15, more: s.median_remaining_at_15 },
                  { t: 30, n: s.n_past_30, more: s.median_remaining_at_30 },
                ].map((row) => (
                  <tr key={row.t}>
                    <th scope="row">{row.t} min</th>
                    <td>{row.n == null ? "—" : `${row.n} of ${s.n}`}</td>
                    <td>{row.more == null ? "too few" : mins(row.more)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="rl-detail-note">
            {r.outages === 0
              ? "No stoppages in this window."
              : `Only ${r.outages} ${r.outages === 1 ? "stoppage" : "stoppages"} — too few to judge. ` +
                "Try a longer window."}
          </p>
        )}
      </div>
      <div>
        {r.outage_bins && r.outages >= MIN_FOR_SHAPE && (
          <>
            <h4 className="rl-detail-h">Stoppage duration · {r.outages}</h4>
            <Histogram bins={r.outage_bins} label={`${rideName(r.name)} stoppage lengths`} />
          </>
        )}
        <h4 className="rl-detail-h">Typical day</h4>
        <dl className="rl-dl">
          <div>
            <dt>Median day</dt>
            <dd>{pct(r.median_day, 1)}</dd>
          </div>
          {r.days >= MIN_DAYS_FOR_P10 && (
            <div>
              <dt>10th percentile day</dt>
              <dd>{pct(r.p10_day, 1)}</dd>
            </div>
          )}
          <div>
            <dt>Days with no stoppage</dt>
            <dd>
              {r.clean_days == null
                ? "—"
                : `${Math.round(r.clean_days * (r.days - r.closed_days))} of ${r.days - r.closed_days}`}
            </dd>
          </div>
          {r.closed_days > 0 && (
            <div>
              <dt>Days out of service</dt>
              <dd>{r.closed_days}</dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}

/** Portrait phone layout. The meter and the name lead; the numbers follow as a
 *  labelled strip, because a seven-column table at 390px is either cut off or
 *  unreadably small. */
function RideCard({
  r,
  open,
  onToggle,
  openDay,
  windowDays,
  showGroup,
}: {
  r: RideStats;
  open: boolean;
  onToggle: () => void;
  openDay: number;
  windowDays: number;
  showGroup: boolean;
}) {
  return (
    <div className={"rl-card" + (open ? " open" : "")}>
      <button className="rl-card-head" onClick={onToggle} aria-expanded={open}>
        <span className="rl-card-title">
          <span className="rl-caret" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className="rl-name-text">{rideName(r.name)}</span>
          {showGroup && r.group && <span className="rl-group">{r.group}</span>}
          {!wellMeasured(r, windowDays) && (
            <span className="rl-thin" title="Present for only part of the window">
              {r.days - r.closed_days}d
            </span>
          )}
        </span>
        <Meter
          value={r.availability}
          title={`${rideName(r.name)} — ${pct(r.availability, 1)} of its scheduled hours`}
        />
        <span className="rl-card-stats">
          <span>
            <b>{r.outages_per_day == null ? "—" : r.outages_per_day.toFixed(1)}</b>/day
          </span>
          <span>
            <b>{mins(r.outage_median)}</b> med
          </span>
          <span>
            <b>{mins(r.outage_p90)}</b> p90
          </span>
          <span>
            <b>{betweenStops(r.minutes_between_outages, openDay)}</b> between
          </span>
          <span>
            <b>{pct(r.clean_days)}</b> clear
          </span>
        </span>
      </button>
      {open && <Detail r={r} />}
    </div>
  );
}

function RideRow({
  r,
  open,
  onToggle,
  openDay,
  windowDays,
  showGroup,
}: {
  r: RideStats;
  open: boolean;
  onToggle: () => void;
  openDay: number;
  windowDays: number;
  showGroup: boolean;
}) {
  return (
    <>
      <tr className={"rl-row" + (open ? " open" : "")}>
        <td className="rl-c-name">
          <button className="rl-name-btn" onClick={onToggle} aria-expanded={open}>
            <span className="rl-caret" aria-hidden="true">
              {open ? "▾" : "▸"}
            </span>
            <span className="rl-name-text">{rideName(r.name)}</span>
            {showGroup && r.group && <span className="rl-group">{r.group}</span>}
            {!wellMeasured(r, windowDays) && (
              <span className="rl-thin" title="Present for only part of the window">
                {r.days - r.closed_days}d
              </span>
            )}
          </button>
        </td>
        <td className="rl-c-meter">
          <Meter
            value={r.availability}
            title={`${rideName(r.name)} — ${pct(r.availability, 1)} of its scheduled hours`}
          />
        </td>
        <td className="rl-num">{r.outages_per_day == null ? "—" : r.outages_per_day.toFixed(1)}</td>
        <td className="rl-num">{mins(r.outage_median)}</td>
        <td className="rl-num">{mins(r.outage_p90)}</td>
        <td className="rl-num rl-hide-sm">{betweenStops(r.minutes_between_outages, openDay)}</td>
        <td className="rl-num rl-hide-sm">{pct(r.clean_days)}</td>
      </tr>
      {open && (
        <tr className="rl-detail-row">
          <td colSpan={COLUMNS.length}>
            <Detail r={r} />
          </td>
        </tr>
      )}
    </>
  );
}

export function UptimePage() {
  const { park } = useParams();
  const parkDef = findPark(park);
  const [data, setData] = useState<UptimeFile | null | undefined>(undefined);
  const [win, setWin] = useState<string>("d28");
  const [openId, setOpenId] = useState<string | null>(null);
  const [sort, setSort] = useState<string>("availability");
  const [desc, setDesc] = useState<boolean>(false);
  const [query, setQuery] = useState("");
  const [showThin, setShowThin] = useState(false);
  // null = the park's first axis; NO_GROUP = a flat ranking.
  const [groupKey, setGroupKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleSection = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  // Portrait phones get cards: seven columns cannot be read at 390px, and
  // hiding enough of them to fit leaves a table that answers nothing.
  const narrow = useMediaQuery("(max-width: 700px)");

  useEffect(() => {
    if (!parkDef) return;
    let alive = true;
    setData(undefined);
    loadUptime(parkDef.key).then((f) => alive && setData(f));
    return () => {
      alive = false;
    };
  }, [parkDef]);

  // Which windows are worth offering. A park we have tracked for eleven days
  // fills 14, 28, 60 and 90 with the same eleven days; showing all five invites
  // clicking between buttons that cannot differ. Keep a window only when it
  // reaches further back than the one before it — and say how far, when a window
  // holds fewer days than its name.
  //
  // This matters more as parks are added: a park onboarded tomorrow has one
  // button for a fortnight, and the page should not pretend otherwise.
  const available = useMemo(() => {
    const out: { key: string; label: string; days: number; short: number | null }[] = [];
    let prev = 0;
    for (const w of WINDOWS) {
      const got = data?.windows?.[w.key]?.days;
      if (!got || got <= prev) continue;
      out.push({ ...w, short: got < w.days ? got : null });
      prev = got;
    }
    return out;
  }, [data]);
  // The chosen window, or the widest one on offer. Resolved against the list
  // the buttons actually show, so a window deduped away can never be the one
  // being displayed with nothing highlighted.
  const winKey =
    available.find((w) => w.key === win)?.key ?? available[available.length - 1]?.key;
  const stats: WindowStats | undefined = winKey ? data?.windows?.[winKey] : undefined;

  // The day-by-day series rides on the widest window only (it is the superset),
  // so slice its tail to whichever window is on screen.
  // The window's CALENDAR length, which is not `stats.days` — that counts the
  // days the park opened. Paulton's shuts midweek, so its "7 days" holds five.
  const winDays = winKey ? Number(winKey.slice(1)) : (stats?.days ?? 0);

  const daily = useMemo(() => {
    const series = Object.values(data?.windows ?? {}).find((w) => w.daily)?.daily;
    if (!series?.length || !winDays) return undefined;
    // Slice by calendar days, not by however many points happen to be there:
    // taking the last N entries of a park that shuts midweek pulls in days from
    // before the window and hides the closures inside it.
    const last = Date.parse(`${series[series.length - 1].date}T00:00:00Z`);
    const from = new Date(last - (winDays - 1) * 86_400_000).toISOString().slice(0, 10);
    return { from, points: series.filter((d) => d.date >= from) };
  }, [data, winDays]);

  const col = COLUMNS.find((c) => c.key === sort) ?? COLUMNS[1];
  const thinCount = useMemo(
    () => (stats?.rides ?? []).filter((r) => !wellMeasured(r, stats?.days ?? 0)).length,
    [stats],
  );
  const rides = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = (stats?.rides ?? []).filter(
      (r) =>
        (showThin || wellMeasured(r, stats?.days ?? 0)) &&
        (!q || r.name.toLowerCase().includes(q) || (r.group ?? "").toLowerCase().includes(q)),
    );
    return [...rows].sort((a, b) => {
      const av = col.get(a);
      const bv = col.get(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const d = typeof av === "string" ? av.localeCompare(bv as string) : av - (bv as number);
      return desc ? -d : d;
    });
  }, [stats, query, col, desc, showThin]);

  const dims = data ? groupOptions(data, stats?.rides ?? []) : [];
  const dim = groupKey ?? dims[0]?.key ?? NO_GROUP;
  const sections = useMemo(() => {
    if (dim === NO_GROUP || !dims.length) return [{ key: "", label: "", rides }];
    const by = new Map<string, RideStats[]>();
    for (const r of rides) {
      const g = groupOf(r, dim) ?? "Other";
      const list = by.get(g);
      if (list) list.push(r);
      else by.set(g, [r]);
    }
    // Section order follows the sort: whichever group holds the current
    // extreme leads, so re-sorting reorders the page rather than just its rows.
    return [...by.entries()].map(([label, list]) => ({ key: label, label, rides: list }));
  }, [rides, dim, dims.length]);

  if (!parkDef) return <Navigate to={PARK_HOME} replace />;

  if (data === undefined) {
    return (
      <main className="rc-main rl-main">
        <p className="rl-empty">Loading…</p>
      </main>
    );
  }
  if (!data || !stats) {
    return (
      <main className="rc-main rl-main">
        <p className="rl-empty">
          No data for {parkDef.label} yet. Built daily from the queue history.
        </p>
      </main>
    );
  }

  const partial = stats.notices_known_days < stats.days;
  // Park-wide stoppages a day: the third figure a reader actually wants beside
  // "how available" and "how does a typical ride do".
  const stopsPerDay = stats.days > 0 ? stats.rides.reduce((n, r) => n + r.outages, 0) / stats.days : null;
  // Only worth mentioning when the feed is so still that the minute figures are
  // genuinely coarse. Blackpool off-season sits here; the Merlin parks never do.
  const coarse = stats.activity < 0.6;

  return (
    <main className="rc-main rl-main">
      <div className="rl-head">
        <div className="rl-hero">
          <div className="rl-hero-label">Rides available</div>
          <div className="rl-hero-num">{pct(stats.availability, 1)}</div>
          <div className="rl-hero-note">
            of their scheduled hours, across {stats.rides.length} rides
          </div>
        </div>
        <div className="rl-tiles">
          <Tile label="Days" value={String(stats.days)} note={`to ${data.to}`} />
          <Tile
            label="Median ride"
            value={pct(stats.median_ride, 1)}
            note={`of ${stats.rides.length} rides`}
          />
          <Tile
            label="Stoppages a day"
            value={stopsPerDay == null ? "—" : stopsPerDay.toFixed(1)}
            note="across the park"
          />
        </div>
      </div>

      <div className="rl-toolbar">
        <div className="rl-toolbar-group" role="group" aria-label="Window">
          <span className="rl-toolbar-label">Window</span>
          {available.map((w) => (
            <button
              key={w.key}
              className={"rl-win" + (w.key === winKey ? " active" : "")}
              onClick={() => setWin(w.key)}
              title={
                w.short == null
                  ? undefined
                  : `Only ${w.short} days of history so far, not ${w.days}`
              }
            >
              {w.label}
              {w.short != null && <span className="rl-win-short">{w.short}</span>}
            </button>
          ))}
        </div>
        {dims.length > 0 && (
          <div className="rl-toolbar-group" role="group" aria-label="Group rides">
            <span className="rl-toolbar-label">Group</span>
            {dims.map((d) => (
              <button
                key={d.key}
                className={"rl-win" + (dim === d.key ? " active" : "")}
                onClick={() => setGroupKey(d.key)}
              >
                {d.label}
              </button>
            ))}
            <button
              className={"rl-win" + (dim === NO_GROUP ? " active" : "")}
              onClick={() => setGroupKey(NO_GROUP)}
            >
              None
            </button>
          </div>
        )}
        {/* Phone-only, exactly as the Queues tab does it: the column headers
            are the sort control wherever the table shows, and the card layout
            has no headers to click. */}
        {narrow && (
          <div className="rl-toolbar-group" role="group" aria-label="Sort rides">
            <span className="rl-toolbar-label">Sort</span>
            {COLUMNS.map((c) => (
              <button
                key={c.key}
                className={"rl-win" + (sort === c.key ? " active" : "")}
                onClick={() => {
                  if (sort === c.key) setDesc(!desc);
                  else {
                    setSort(c.key);
                    setDesc(c.desc);
                  }
                }}
              >
                {c.label}
                {sort === c.key && (
                  <span className="rl-sort-arrow">{desc ? "▼" : "▲"}</span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="rl-toolbar-group">
          {thinCount > 0 && (
            <button
              className={"rl-win" + (showThin ? " active" : "")}
              onClick={() => setShowThin(!showThin)}
              title="Present for only part of the window, so the numbers are thin"
            >
              {showThin ? "Hide" : "Show"} {thinCount} with little data
            </button>
          )}
          <input
            type="search"
            className="rl-search"
            placeholder="Filter rides…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter rides by name or group"
          />
        </div>
      </div>

      {daily && daily.points.length >= 3 && (
        <DayStrip daily={daily.points} from={daily.from} />
      )}

      {narrow ? (
        <div className="rl-cards">
          {sections.map((sec) => (
            <Fragment key={sec.key}>
              {sec.label && (
                <button
                  className="rl-section-btn rl-section-card"
                  onClick={() => toggleSection(sec.key)}
                  aria-expanded={!collapsed.has(sec.key)}
                >
                  <span className="rl-caret" aria-hidden="true">
                    {collapsed.has(sec.key) ? "▸" : "▾"}
                  </span>
                  {sec.label}
                  <span className="rl-section-n">{sec.rides.length}</span>
                </button>
              )}
              {!collapsed.has(sec.key) &&
                sec.rides.map((r) => (
                  <RideCard
                    key={r.id}
                    r={r}
                    openDay={stats.open_minutes_mean ?? 0}
                    windowDays={stats.days}
                    showGroup={dim === NO_GROUP}
                    open={openId === r.id}
                    onToggle={() => setOpenId(openId === r.id ? null : r.id)}
                  />
                ))}
            </Fragment>
          ))}
          {rides.length === 0 && <p className="rl-empty">No ride matches “{query}”.</p>}
        </div>
      ) : (
      <table className="rl-table">
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={
                  (c.key === "name"
                    ? "rl-c-name"
                    : c.key === "availability"
                      ? "rl-c-meter"
                      : "rl-num") +
                  (c.wide ? " rl-hide-sm" : "") +
                  (sort === c.key ? " sorted" : "")
                }
                aria-sort={sort === c.key ? (desc ? "descending" : "ascending") : "none"}
              >
                <button
                  className="rl-sort"
                  title={c.title}
                  onClick={() => {
                    if (sort === c.key) setDesc(!desc);
                    else {
                      setSort(c.key);
                      setDesc(c.desc);
                    }
                  }}
                >
                  {c.label}
                  <span className="rl-sort-arrow" aria-hidden="true">
                    {sort === c.key ? (desc ? "▼" : "▲") : ""}
                  </span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sections.map((sec) => (
            <Fragment key={sec.key}>
              {sec.label && (
                <tr className="rl-section">
                  <th colSpan={COLUMNS.length} scope="colgroup">
                    <button
                      className="rl-section-btn"
                      onClick={() => toggleSection(sec.key)}
                      aria-expanded={!collapsed.has(sec.key)}
                    >
                      <span className="rl-caret" aria-hidden="true">
                        {collapsed.has(sec.key) ? "▸" : "▾"}
                      </span>
                      {sec.label}
                      <span className="rl-section-n">{sec.rides.length}</span>
                    </button>
                  </th>
                </tr>
              )}
              {!collapsed.has(sec.key) &&
                sec.rides.map((r) => (
                  <RideRow
                    key={r.id}
                    r={r}
                    openDay={stats.open_minutes_mean ?? 0}
                    windowDays={stats.days}
                    showGroup={dim === NO_GROUP}
                    open={openId === r.id}
                    onToggle={() => setOpenId(openId === r.id ? null : r.id)}
                  />
                ))}
            </Fragment>
          ))}
          {rides.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length} className="rl-empty">
                No ride matches “{query}”.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      )}

      <div className="rl-foot">
        <p>
          Availability is the share of a ride's <strong>own</strong> scheduled hours it was
          running. Hours it wasn't due to run don't count, nor do declared seasonal closures.
        </p>
        <p>
          The feed says a ride stopped, never why: cleaning and a mechanical failure look
          identical.
        </p>
        {coarse && (
          <p>This park's waits rarely change, so times here are coarser. Nothing is missing.</p>
        )}
        {(stats.partial_days ?? 0) > 0 && (
          <p>
            {stats.partial_days} {stats.partial_days === 1 ? "day covers" : "days cover"} only
            part of the park's hours, because collection started after opening. Those hours are
            left out rather than counted against the rides.
          </p>
        )}
        {partial && (
          <p>
            {stats.notices_known_days === 0
              ? "No days here record why a ride was shut"
              : `Only ${stats.notices_known_days} of ${stats.days} days record why a ride was shut`}
            , so some stoppages may have been planned.
          </p>
        )}
      </div>
    </main>
  );
}
