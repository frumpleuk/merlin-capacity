import { useState } from "react";
import type { DayObs, ProductFile, RecentReading } from "./api";

const DOW = ["M", "T", "W", "T", "F", "S", "S"];

/** Colour by fraction available: 0 → red, high → green. RAP is a hard pool, so
 *  the availability fraction reads as "how gettable is this day". */
export function colour(available: number, capacity: number): string {
  if (capacity <= 0) return "var(--grid)";
  const f = Math.max(0, Math.min(1, available / capacity));
  const hue = 120 * f; // 0=red .. 120=green
  const light = 45 + 30 * (1 - f); // sold-out days darker
  return `hsl(${hue.toFixed(0)} 65% ${light.toFixed(0)}%)`;
}

export function monthLabel(mk: string): string {
  return new Date(`${mk}-01T00:00:00Z`).toLocaleString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Month({
  mk,
  days,
  selectedIso,
  onSelect,
}: {
  mk: string;
  days: Record<string, DayObs>;
  selectedIso: string | null;
  onSelect: (iso: string) => void;
}) {
  const first = new Date(`${mk}-01T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7; // Mon = 0
  const daysInMonth = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();

  const today = new Date().toISOString().slice(0, 10);
  const cells = [];
  for (let i = 0; i < lead; i++) {
    cells.push(<div key={`pad${i}`} className="cell empty" />);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${mk}-${String(day).padStart(2, "0")}`;
    const isToday = iso === today;
    const o = days[iso];
    if (!o) {
      cells.push(
        <div key={iso} className={"cell empty" + (isToday ? " today" : "")} />,
      );
      continue;
    }
    const cls =
      "cell" +
      (o.available === 0 ? " sold" : "") +
      (selectedIso === iso ? " sel" : "") +
      (isToday ? " today" : "");
    cells.push(
      <div
        key={iso}
        className={cls}
        style={{ background: colour(o.available, o.capacity) }}
        onClick={() => onSelect(iso)}
        role="button"
        tabIndex={0}
        aria-label={`${iso}: ${o.available} available of ${o.capacity}`}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(iso);
          }
        }}
      >
        {day}
      </div>,
    );
  }

  return (
    <div className="month">
      <h3>{monthLabel(mk)}</h3>
      <div className="grid">
        {DOW.map((l, i) => (
          <div key={i} className="dow">
            {l}
          </div>
        ))}
        {cells}
      </div>
    </div>
  );
}

export function ProductCalendar({
  file,
  selectedIso,
  onSelect,
}: {
  file: ProductFile;
  selectedIso: string | null;
  onSelect: (iso: string) => void;
}) {
  const dates = Object.keys(file.days).sort();
  const byMonth: Record<string, Record<string, DayObs>> = {};
  for (const d of dates) (byMonth[d.slice(0, 7)] ??= {})[d] = file.days[d];

  return (
    <div className="months">
      {Object.keys(byMonth)
        .sort()
        .map((mk) => (
          <Month
            key={mk}
            mk={mk}
            days={byMonth[mk]}
            selectedIso={selectedIso}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

/** How far back the activity list reaches; matches the backend's window. */
const RECENT_HOURS = 6;

/** One movement between two consecutive readings of a date. */
interface Movement {
  at: Date;
  /** Places sold (positive) or come back (negative), net of any release. */
  sold: number;
  /** Capacity added (positive) or withdrawn (negative). */
  released: number;
  left: number;
  /** A return in the minutes accesso sweeps held places back every 15 minutes. */
  sweep: boolean;
}

/** Returns cluster at :06, :21, :36 and :51, at about twenty times the rate of
 *  any other minute (Alton RAP, 24-26 Sep 2026): accesso releasing places on a
 *  15-minute cycle. Away from those minutes a return is party-sized (1-4 places,
 *  860 of 881 since 19 Sep), which reads as a cancellation in the RAP app. The
 *  sweeps carry the same 1-4 sizes at six times the rate plus nearly every large
 *  block (76 of 77 returns of 11+), so they may be expired baskets or batched
 *  cancellations; the data can't tell them apart. The minute after catches the
 *  sweeps that land late. */
const isSweepMinute = (d: Date) => [6, 7].includes(d.getUTCMinutes() % 15);

function movements(readings: RecentReading[], since: number): Movement[] {
  const out: Movement[] = [];
  for (let i = 1; i < readings.length; i++) {
    const [, c0, a0] = readings[i - 1];
    const [t, c1, a1] = readings[i];
    const at = new Date(t);
    if (at.getTime() < since) continue;
    const released = c1 - c0;
    const sold = released - (a1 - a0);
    if (sold === 0 && released === 0) continue;
    out.push({ at, sold, released, left: a1, sweep: sold < 0 && isSweepMinute(at) });
  }
  return out.reverse(); // newest first
}

const hhmm = (d: Date) =>
  d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

function describe(m: Movement): string {
  const parts: string[] = [];
  if (m.released > 0) parts.push(`${m.released.toLocaleString()} released`);
  if (m.released < 0) parts.push(`${(-m.released).toLocaleString()} withdrawn`);
  if (m.sold > 0) parts.push(`${m.sold.toLocaleString()} sold`);
  if (m.sold < 0)
    parts.push(
      m.sweep
        ? `${(-m.sold).toLocaleString()} came back (15-min sweep)`
        : `${(-m.sold).toLocaleString()} cancelled`,
    );
  return parts.join(", ");
}

/** The day's sales, returns and releases over the last few hours. On a sold-out
 *  day this is the only place the churn shows: the day reads 0 left throughout
 *  while places come back and go again within a minute or two. */
function RecentActivity({ readings }: { readings: RecentReading[] }) {
  const [open, setOpen] = useState(false);
  const ms = movements(readings, Date.now() - RECENT_HOURS * 3_600_000);
  if (ms.length === 0) {
    return <div className="recent-summary">No movement in the last {RECENT_HOURS} hours.</div>;
  }
  const sold = ms.reduce((n, m) => n + Math.max(0, m.sold), 0);
  const back = ms.reduce((n, m) => n + Math.max(0, -m.sold), 0);
  const swept = ms.reduce((n, m) => n + (m.sweep ? -m.sold : 0), 0);
  const released = ms.reduce((n, m) => n + m.released, 0);
  const summary = [
    `${sold.toLocaleString()} sold`,
    `${(back - swept).toLocaleString()} cancelled`,
    ...(swept ? [`${swept.toLocaleString()} back in sweeps`] : []),
    ...(released > 0 ? [`${released.toLocaleString()} released`] : []),
    ...(released < 0 ? [`${(-released).toLocaleString()} withdrawn`] : []),
  ].join(" · ");
  return (
    <div className="recent">
      <div className="recent-summary">
        Last {RECENT_HOURS}h: {summary}.{" "}
        <button
          className="recent-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="recent-list"
        >
          {open ? "Hide" : `Show ${ms.length} change${ms.length === 1 ? "" : "s"}`}
        </button>
      </div>
      {open && (
        <>
          <ol id="recent-list" className="recent-list">
            {ms.map((m) => (
              <li key={m.at.toISOString()} className={m.sold < 0 ? "back" : m.sold > 0 ? "sold" : "rel"}>
                <time dateTime={m.at.toISOString()}>{hhmm(m.at)}</time>
                <span className="recent-what">{describe(m)}</span>
                <span className="recent-left">{Math.max(0, m.left).toLocaleString()} left</span>
              </li>
            ))}
          </ol>
          <p className="recent-note">
            Readings are a minute apart, so a sale and a return in the same minute cancel out.
            A return of a few places at any other minute is most likely a cancellation in the
            RAP app. Returns at :06, :21, :36 and :51 are accesso releasing places on a
            15-minute cycle: expired baskets, or cancellations processed in a batch.
          </p>
        </>
      )}
    </div>
  );
}

/** Fixed bar pinned to the bottom of the viewport, so the tapped day's numbers
 *  are always visible no matter how far down the calendar you've scrolled. */
export function DetailBar({
  label,
  iso,
  o,
  recent,
  onClose,
}: {
  label: string;
  iso: string;
  o: DayObs;
  /** This date's recent readings, where the product keeps them (RAP). */
  recent?: RecentReading[];
  onClose: () => void;
}) {
  const pct = o.capacity > 0 ? Math.round((o.available / o.capacity) * 100) : null;
  return (
    <div className="detail-bar" role="status" aria-live="polite">
      <div className="detail-text">
        <span className="detail-product">{label}</span>{" "}
        <strong>{longDate(iso)}</strong>: <strong>{o.available.toLocaleString()}</strong> of{" "}
        <strong>{o.capacity.toLocaleString()}</strong> available
        {pct !== null && `, ${pct}% left`}. Used{" "}
        <strong>{o.used.toLocaleString()}</strong>.
        {recent && <RecentActivity key={iso} readings={recent} />}
      </div>
      <button className="detail-close" onClick={onClose} aria-label="Close detail">
        ×
      </button>
    </div>
  );
}
