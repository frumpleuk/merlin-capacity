import type { DayObs, ProductFile } from "./api";

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
      "cell" + (o.available === 0 ? " sold" : "") + (selectedIso === iso ? " sel" : "");
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

/** Fixed bar pinned to the bottom of the viewport, so the tapped day's numbers
 *  are always visible no matter how far down the calendar you've scrolled. */
export function DetailBar({
  label,
  iso,
  o,
  onClose,
}: {
  label: string;
  iso: string;
  o: DayObs;
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
      </div>
      <button className="detail-close" onClick={onClose} aria-label="Close detail">
        ×
      </button>
    </div>
  );
}
