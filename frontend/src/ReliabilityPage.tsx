import { useEffect, useMemo, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import {
  loadReliability,
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
 * and the number sits beside it, so the bar never has to be read alone.
 *
 * One hero figure: the park's own availability. Everything else is a stat tile
 * or a table cell.
 */

const SCREENSHOT_OPEN: string | null = null;

const WINDOWS = [
  { key: "d7", label: "7 days" },
  { key: "d28", label: "28 days" },
  { key: "d90", label: "90 days" },
] as const;

/** Some catalogs append an advisory to the name — Thorpe's Ready Player One is
 *  "… | Age Rating 12A". Useful in the park, noise in a ranking. */
const rideName = (n: string): string => n.split("|")[0].trim();

const pct = (x: number | null | undefined, dp = 0): string =>
  x == null ? "—" : `${(x * 100).toFixed(dp)}%`;

const mins = (x: number | null | undefined): string =>
  x == null ? "—" : `${Math.round(x)}m`;

/** "4h 45m" reads faster than "285m" once it's past an hour or so. */
function duration(x: number | null | undefined): string {
  if (x == null) return "—";
  const m = Math.round(x);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

/** The magnitude meter: fill is availability, track is a lighter step of the
 *  same hue. No border between them — the track IS the remainder. */
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

/** One stat beside the hero figure. */
function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rl-tile">
      <div className="rl-tile-label">{label}</div>
      <div className="rl-tile-value">{value}</div>
      {note && <div className="rl-tile-note">{note}</div>}
    </div>
  );
}

/** The stay-or-go panel, shown when a row is expanded. Three cumulative shares
 *  plus the conditional pair, which is the part people get wrong: having waited
 *  fifteen minutes does not mean you are fifteen minutes closer. */
function Survival({ r }: { r: RideStats }) {
  const s = r.outage_survival;
  if (!s) {
    return (
      <p className="rl-detail-note">
        Too few stoppages in this window to say anything useful about how long they last.
      </p>
    );
  }
  const bars = [
    { t: "15 min", v: s.resume_within_15 },
    { t: "30 min", v: s.resume_within_30 },
    { t: "60 min", v: s.resume_within_60 },
  ];
  return (
    <div className="rl-detail-grid">
      <div>
        <h4 className="rl-detail-h">If it stops, it's back within…</h4>
        <table className="rl-survival">
          <tbody>
            {bars.map((b) => (
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
      </div>
      <div>
        <h4 className="rl-detail-h">Already been down a while?</h4>
        <dl className="rl-dl">
          <div>
            <dt>15 minutes in</dt>
            <dd>{s.median_remaining_at_15 == null ? "—" : `about ${mins(s.median_remaining_at_15)} more`}</dd>
          </div>
          <div>
            <dt>30 minutes in</dt>
            <dd>{s.median_remaining_at_30 == null ? "—" : `about ${mins(s.median_remaining_at_30)} more`}</dd>
          </div>
        </dl>
        <p className="rl-detail-note">
          Waiting selects for the long stoppages, so the time already spent doesn't come off
          the estimate.
        </p>
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

function RideRow({ r, open, onToggle }: { r: RideStats; open: boolean; onToggle: () => void }) {
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
        <td className="rl-num rl-hide-sm">{duration(r.minutes_between_outages)}</td>
        <td className="rl-num rl-hide-sm">{pct(r.clean_days)}</td>
      </tr>
      {open && (
        <tr className="rl-detail-row">
          <td colSpan={7}>
            <Survival r={r} />
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
  const [openId, setOpenId] = useState<string | null>(SCREENSHOT_OPEN);

  useEffect(() => {
    if (!parkDef) return;
    let alive = true;
    setData(undefined);
    loadReliability(parkDef.key).then((f) => alive && setData(f));
    return () => {
      alive = false;
    };
  }, [parkDef]);

  // Fall back to whatever windows the file actually has — a park tracked for
  // three weeks has no 90-day window and shouldn't show an empty tab.
  const available = useMemo(
    () => WINDOWS.filter((w) => data?.windows?.[w.key]),
    [data],
  );
  const stats: WindowStats | undefined =
    data?.windows?.[win] ?? (available.length ? data?.windows?.[available[available.length - 1].key] : undefined);

  if (!parkDef) return <Navigate to={PARK_HOME} replace />;

  if (data === undefined) {
    return (
      <main className="rc-main">
        <p className="rl-empty">Loading…</p>
      </main>
    );
  }
  if (!data || !stats) {
    return (
      <main className="rc-main">
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
          <Tile
            label="Typical ride"
            value={pct(stats.geometric_mean, 1)}
            note="geometric mean"
          />
          <Tile
            label="Data coverage"
            value={pct(stats.coverage)}
            note={lowCoverage ? "polling gaps" : "complete"}
          />
        </div>
      </div>

      <div className="rl-toolbar" role="group" aria-label="Window">
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

      <table className="rl-table">
        <thead>
          <tr>
            <th scope="col" className="rl-c-name">
              Ride
            </th>
            <th scope="col" className="rl-c-meter">
              Available
            </th>
            <th scope="col" className="rl-num" title="Stoppages per day it ran">
              Stops/day
            </th>
            <th scope="col" className="rl-num" title="Median length of a stoppage">
              Median
            </th>
            <th scope="col" className="rl-num" title="One stoppage in ten lasts at least this">
              p90
            </th>
            <th scope="col" className="rl-num rl-hide-sm" title="Scheduled time between stoppages">
              Between
            </th>
            <th scope="col" className="rl-num rl-hide-sm" title="Days with no stoppage at all">
              Clear days
            </th>
          </tr>
        </thead>
        <tbody>
          {stats.rides.map((r) => (
            <RideRow
              key={r.id}
              r={r}
              open={openId === r.id}
              onToggle={() => setOpenId(openId === r.id ? null : r.id)}
            />
          ))}
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
