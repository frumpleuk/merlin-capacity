import { useState } from "react";
import type { DayObs, ProductFile } from "./api";

const DOW = ["M", "T", "W", "T", "F", "S", "S"];

/** Colour by fraction available: 0 → red, high → green. RAP is a hard pool, so
 *  the availability fraction reads as "how gettable is this day". */
function colour(available: number, capacity: number): string {
  if (capacity <= 0) return "var(--grid)";
  const f = Math.max(0, Math.min(1, available / capacity));
  const hue = 120 * f; // 0=red .. 120=green
  const light = 45 + 30 * (1 - f); // sold-out days darker
  return `hsl(${hue.toFixed(0)} 65% ${light.toFixed(0)}%)`;
}

function monthLabel(mk: string): string {
  return new Date(`${mk}-01T00:00:00Z`).toLocaleString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Tap/click detail — the mobile-friendly replacement for hover tooltips. */
function Detail({ iso, o }: { iso: string; o: DayObs }) {
  const pct = o.capacity > 0 ? Math.round((o.available / o.capacity) * 100) : null;
  return (
    <div className="detail" aria-live="polite">
      <strong>{longDate(iso)}</strong>
      {" — "}
      available <strong>{o.available.toLocaleString()}</strong> of{" "}
      <strong>{o.capacity.toLocaleString()}</strong>
      {pct !== null && ` (${pct}% left)`}, used{" "}
      <strong>{o.used.toLocaleString()}</strong>
    </div>
  );
}

function Month({
  mk,
  days,
  selected,
  onSelect,
}: {
  mk: string;
  days: Record<string, DayObs>;
  selected: string | null;
  onSelect: (iso: string) => void;
}) {
  const first = new Date(`${mk}-01T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7; // Mon = 0
  const daysInMonth = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();

  const cells = [];
  for (let i = 0; i < lead; i++) {
    cells.push(<div key={`pad${i}`} className="cell empty" />);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${mk}-${String(day).padStart(2, "0")}`;
    const o = days[iso];
    if (!o) {
      cells.push(<div key={iso} className="cell empty" />);
      continue;
    }
    const cls =
      "cell" + (o.available === 0 ? " sold" : "") + (selected === iso ? " sel" : "");
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

export function ProductCalendar({ file }: { file: ProductFile }) {
  const [selected, setSelected] = useState<string | null>(null);
  const dates = Object.keys(file.days).sort();
  const totalAvail = dates.reduce((a, d) => a + (file.days[d].available || 0), 0);

  const byMonth: Record<string, Record<string, DayObs>> = {};
  for (const d of dates) (byMonth[d.slice(0, 7)] ??= {})[d] = file.days[d];

  const toggle = (iso: string) =>
    setSelected((prev) => (prev === iso ? null : iso));

  const selDay = selected ? file.days[selected] : null;

  return (
    <section className="product">
      <h2>{file.product}</h2>
      <div className="legend">
        {dates.length} dates · {totalAvail.toLocaleString()} tickets available ·
        tap a day for detail
      </div>
      {selDay ? (
        <Detail iso={selected!} o={selDay} />
      ) : (
        <div className="detail placeholder">Tap a day to see its numbers</div>
      )}
      <div className="months">
        {Object.keys(byMonth)
          .sort()
          .map((mk) => (
            <Month
              key={mk}
              mk={mk}
              days={byMonth[mk]}
              selected={selected}
              onSelect={toggle}
            />
          ))}
      </div>
    </section>
  );
}
