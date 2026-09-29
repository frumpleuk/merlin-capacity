import { useEffect, useMemo, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import {
  loadReliability,
  RELIABILITY_BINS,
  type DailyPoint,
  type ReliabilityFile,
  type RideStats,
  type WindowStats,
} from "./api";
import { findPark, PARK_HOME } from "./catalog";

/* ── Ride reliability ──────────────────────────────────────────────────────────
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
  { key: "d7", label: "7 days" },
  { key: "d28", label: "28 days" },
  { key: "d90", label: "90 days" },
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
    title:
      "Mean operating time per stoppage (MTBF) — how long it runs before stopping again. " +
      "Park hours only, so overnight doesn't count.",
    desc: false,
    wide: true,
    get: (r) => r.minutes_between_outages,
  },
  {
    key: "clean_days",
    label: "Clear days",
    title: "Days it ran with no stoppage at all",
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
  const e = RELIABILITY_BINS;
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
        <div className="rl-hist-col" key={i} title={`${name(i)}: ${n} of ${total} stoppages`}>
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
 * Day by day, so a particular visit can be put against the window it sits in —
 * was that day bad, or is it always like this. One column per day, oldest left.
 */
function DayStrip({ daily }: { daily: DailyPoint[] }) {
  const vals = daily.map((d) => d.availability).filter((x): x is number => x != null);
  if (vals.length < 3) return null;
  const mid = median(vals) ?? 0;
  // The axis floors just below the worst day rather than at zero. Every value
  // sits in the top fifth of the range, so a zero baseline flattens them all to
  // the same bar; the floor is printed under the strip so it can't mislead.
  const lo = Math.max(0, Math.min(...vals) - 0.02);
  const scale = (v: number) => ((v - lo) / (1 - lo)) * 100;
  return (
    <div className="rl-strip-wrap">
      <div className="rl-strip">
        {daily.map((d) => (
          <div
            className="rl-strip-col"
            key={d.date}
            title={`${d.date}: ${pct(d.availability, 1)} available, ${d.outages} stoppages${
              d.closed_rides ? `, ${d.closed_rides} rides not running` : ""
            }`}
          >
            <div
              className="rl-strip-bar"
              style={{ height: `${d.availability == null ? 0 : scale(d.availability)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="rl-strip-axis">
        <span>{daily[0].date}</span>
        <span>
          {pct(lo, 0)}–100% · median {pct(mid, 1)}
        </span>
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
            <h4 className="rl-detail-h">If it stops, it's back within…</h4>
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
                      <Meter value={b.v} title={`${pct(b.v)} of stoppages cleared within ${b.t}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="rl-detail-note">From {s.n} stoppages in this window.</p>
            <h4 className="rl-detail-h">Once it has been down…</h4>
            <dl className="rl-dl">
              <div>
                <dt>15 minutes</dt>
                <dd>
                  {s.median_remaining_at_15 == null
                    ? "—"
                    : `about ${mins(s.median_remaining_at_15)} more`}
                </dd>
              </div>
              <div>
                <dt>30 minutes</dt>
                <dd>
                  {s.median_remaining_at_30 == null
                    ? "—"
                    : `about ${mins(s.median_remaining_at_30)} more`}
                </dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="rl-detail-note">
            Too few stoppages in this window to say how long they last.
          </p>
        )}
      </div>
      <div>
        {r.outage_bins && (
          <>
            <h4 className="rl-detail-h">How long they last</h4>
            <Histogram bins={r.outage_bins} label={`${rideName(r.name)} stoppage lengths`} />
          </>
        )}
        <h4 className="rl-detail-h">Typical day</h4>
        <dl className="rl-dl">
          <div>
            <dt>Median day</dt>
            <dd>{pct(r.median_day, 1)}</dd>
          </div>
          <div>
            <dt>Worst day in ten</dt>
            <dd>{pct(r.p10_day, 1)}</dd>
          </div>
          <div>
            <dt>Days with no stoppage</dt>
            <dd>{pct(r.clean_days)}</dd>
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

function RideRow({
  r,
  open,
  onToggle,
  openDay,
  windowDays,
}: {
  r: RideStats;
  open: boolean;
  onToggle: () => void;
  openDay: number;
  windowDays: number;
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
            {r.group && <span className="rl-group">{r.group}</span>}
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
            title={`${rideName(r.name)}: available ${pct(r.availability, 1)} of its scheduled hours`}
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

export function ReliabilityPage() {
  const { park } = useParams();
  const parkDef = findPark(park);
  const [data, setData] = useState<ReliabilityFile | null | undefined>(undefined);
  const [win, setWin] = useState<string>("d28");
  const [openId, setOpenId] = useState<string | null>(null);
  const [sort, setSort] = useState<string>("availability");
  const [desc, setDesc] = useState<boolean>(false);
  const [query, setQuery] = useState("");
  const [showThin, setShowThin] = useState(false);

  useEffect(() => {
    if (!parkDef) return;
    let alive = true;
    setData(undefined);
    loadReliability(parkDef.key).then((f) => alive && setData(f));
    return () => {
      alive = false;
    };
  }, [parkDef]);

  // Fall back to whatever windows the file has — a park tracked for three weeks
  // has no 90-day window and shouldn't show an empty tab.
  const available = useMemo(() => WINDOWS.filter((w) => data?.windows?.[w.key]), [data]);
  const stats: WindowStats | undefined =
    data?.windows?.[win] ??
    (available.length ? data?.windows?.[available[available.length - 1].key] : undefined);

  // The day-by-day series rides on the widest window only (it is the superset),
  // so slice its tail to whichever window is on screen.
  const daily = useMemo(() => {
    const series = Object.values(data?.windows ?? {}).find((w) => w.daily)?.daily;
    if (!series || !stats) return undefined;
    return series.slice(-stats.days);
  }, [data, stats]);

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
          No reliability data for {parkDef.label} yet. It's built once a day from the queue
          history.
        </p>
      </main>
    );
  }

  const partial = stats.notices_known_days < stats.days;
  const lowCoverage = stats.coverage < 0.9;

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
          <Tile label="Typical ride" value={pct(stats.geometric_mean, 1)} note="geometric mean" />
          <Tile
            label="Data coverage"
            value={pct(stats.coverage)}
            note={lowCoverage ? "polling gaps" : "complete"}
          />
        </div>
      </div>

      {daily && daily.length >= 3 && <DayStrip daily={daily} />}

      <div className="rl-toolbar">
        <div className="rl-toolbar-group" role="group" aria-label="Window">
          <span className="rl-toolbar-label">Window</span>
          {available.map((w) => (
            <button
              key={w.key}
              className={"rl-win" + (stats === data.windows[w.key] ? " active" : "")}
              onClick={() => setWin(w.key)}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="rl-toolbar-group">
          {thinCount > 0 && (
            <button
              className={"rl-win" + (showThin ? " active" : "")}
              onClick={() => setShowThin(!showThin)}
              title="Rides present for only part of the window — a handful of days can't support these numbers"
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
          {rides.map((r) => (
            <RideRow
              key={r.id}
              r={r}
              openDay={stats.open_minutes_mean ?? 0}
              windowDays={stats.days}
              open={openId === r.id}
              onToggle={() => setOpenId(openId === r.id ? null : r.id)}
            />
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

      <div className="rl-foot">
        <p>
          Availability is the share of each ride's <strong>own</strong> scheduled hours that it
          was open and running. Time outside its hours doesn't count against it, and nor does a
          season the park has said it is closed for.
        </p>
        <p>
          <strong>Outage</strong>, not fault: the feed reports that a ride stopped, never why. A
          station closed to be cleaned up reads exactly like a mechanical failure.
        </p>
        {partial && (
          <p>
            {stats.notices_known_days} of {stats.days} days can say why a ride was shut; for the
            rest the reason wasn't recorded, so some closures counted here may have been planned.
          </p>
        )}
      </div>
    </main>
  );
}
