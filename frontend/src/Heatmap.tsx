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

function Month({ mk, days }: { mk: string; days: Record<string, DayObs> }) {
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
    cells.push(
      <div
        key={iso}
        className={`cell${o.available === 0 ? " sold" : ""}`}
        style={{ background: colour(o.available, o.capacity) }}
        title={
          `${iso}\navailable: ${o.available.toLocaleString()}\n` +
          `capacity: ${o.capacity.toLocaleString()}\nused: ${o.used.toLocaleString()}`
        }
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
  const dates = Object.keys(file.days).sort();
  const totalAvail = dates.reduce((a, d) => a + (file.days[d].available || 0), 0);

  const byMonth: Record<string, Record<string, DayObs>> = {};
  for (const d of dates) (byMonth[d.slice(0, 7)] ??= {})[d] = file.days[d];

  return (
    <section className="product">
      <h2>{file.product}</h2>
      <div className="legend">
        {dates.length} dates · {totalAvail.toLocaleString()} tickets available ·
        red outline = sold out · hover a day for detail
      </div>
      <div className="months">
        {Object.keys(byMonth)
          .sort()
          .map((mk) => (
            <Month key={mk} mk={mk} days={byMonth[mk]} />
          ))}
      </div>
    </section>
  );
}
