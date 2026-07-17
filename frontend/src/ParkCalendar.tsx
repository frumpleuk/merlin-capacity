import { useEffect, useState } from "react";
import type { DayObs, HoursDay, HoursFile, LocationHours, ProductFile } from "./api";
import { colour, longDate, monthLabel } from "./Heatmap";
import { useMediaQuery } from "./useMediaQuery";

const DOW = ["M", "T", "W", "T", "F", "S", "S"];
const KIND_ICON: Record<string, string> = {
  themepark: "🎢",
  waterpark: "🏊",
  golf: "⛳️",
};

/** Everything known about one day for one park, merged from the three files. */
export interface DayDetail {
  iso: string;
  hours?: HoursDay;
  event?: string;
  main?: DayObs;
  rap?: DayObs;
}

function getEventIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("christmas")) return "🎄";
  if (n.includes("brick or treat")) return "🎃";
  if (n.includes("scarefest")) return "🎃";
  if (n.includes("fireworks")) return "🎆";
  if (n.includes("fright")) return "👻";
  if (n.includes("halloween")) return "🎃";
  if (n.includes("fifa") || n.includes("world cup") || n.includes("football")) return "⚽";
  if (n.includes("minecraft")) return "⛏️";
  if (n.includes("summer")) return "☀️";
  if (n.includes("winter")) return "❄️";
  return "🎉";
}

interface AvailStatus {
  emoji: string;
  label: string;
}
/** Availability status for either pool (main or RAP), by fraction remaining. */
function availStatus(o: DayObs): AvailStatus {
  if (o.available <= 0) return { emoji: "❌", label: "Sold out" };
  const f = o.available / o.capacity;
  if (f < 0.1) return { emoji: "🟡", label: "Very limited" };
  if (f < 0.3) return { emoji: "🟠", label: "Limited" };
  return { emoji: "✅", label: "Available" };
}

/** Whether a pool has a meaningful allocation to show. Main goes degenerate
 *  (capacity 0) once advance sales close; RAP is capacity 0 when a date has no
 *  allocation — in both cases "0/0" is noise, so we hide the line entirely. */
const hasAllocation = (o?: DayObs): o is DayObs => !!o && o.capacity > 0;

/** Compact "12/1,960" figure for a cell. */
const avNums = (o: DayObs) =>
  `${o.available.toLocaleString()}/${o.capacity.toLocaleString()}`;

const themepark = (h?: HoursDay): LocationHours | undefined =>
  h?.locations.find((l) => l.kind === "themepark");
const extraLocations = (h?: HoursDay): LocationHours[] =>
  (h?.locations ?? []).filter((l) => l.kind !== "themepark");

/** Merge the three per-park files into one map keyed by ISO date, over the
 *  union of every date any file mentions. */
export function mergeDetails(
  main: ProductFile | null,
  rap: ProductFile | null,
  hours: HoursFile | null,
): Map<string, DayDetail> {
  const map = new Map<string, DayDetail>();
  const get = (iso: string): DayDetail => {
    let d = map.get(iso);
    if (!d) map.set(iso, (d = { iso }));
    return d;
  };
  for (const [iso, o] of Object.entries(hours?.days ?? {})) {
    const d = get(iso);
    d.hours = o;
    d.event = o.event;
  }
  for (const [iso, o] of Object.entries(main?.days ?? {})) get(iso).main = o;
  for (const [iso, o] of Object.entries(rap?.days ?? {})) get(iso).rap = o;
  return map;
}

/* ── Compact cell content (desktop month grid) ─────────────────────────────── */

function CellContent({ d }: { d: DayDetail }) {
  const tp = themepark(d.hours);
  const closed = tp && /^closed$/i.test(tp.hours);
  const extras = extraLocations(d.hours).filter((l) => l.hours && !/^closed$/i.test(l.hours));

  return (
    <>
      {closed ? (
        <div className="rc-closed">Closed</div>
      ) : tp?.hours ? (
        <div className="rc-line rc-hours">🎢 {tp.hours}</div>
      ) : null}
      {extras.map((l) => (
        <div key={l.kind} className="rc-line rc-extra">
          {KIND_ICON[l.kind] ?? "🏢"} {l.hours}
        </div>
      ))}
      {d.event && (
        <div className="rc-line rc-event">
          {getEventIcon(d.event)} {d.event}
        </div>
      )}
      {hasAllocation(d.main) && (
        <div className="rc-line rc-avail">
          {availStatus(d.main).emoji} 🎟️ {avNums(d.main)}
        </div>
      )}
      {hasAllocation(d.rap) && (
        <div className="rc-line rc-avail">
          {availStatus(d.rap).emoji} RAP {avNums(d.rap)}
        </div>
      )}
    </>
  );
}

/* ── Full detail body (tap sheet + agenda card) ────────────────────────────── */

function DayBody({ d }: { d: DayDetail }) {
  const locs = d.hours?.locations ?? [];
  return (
    <div className="rc-body">
      {locs.length > 0 ? (
        locs.map((l) => (
          <div key={l.kind} className="rc-body-loc">
            <span className="rc-body-icon">{KIND_ICON[l.kind] ?? "🏢"}</span>
            <span className="rc-body-name">{l.name || l.kind}</span>
            <span className="rc-body-hours">
              {l.hours || "—"}
              {l.lastEntry ? ` · ${l.lastEntry}` : ""}
            </span>
          </div>
        ))
      ) : (
        <div className="rc-body-loc rc-muted">No opening hours</div>
      )}
      {d.event && (
        <div className="rc-body-event">
          {getEventIcon(d.event)} {d.event}
        </div>
      )}
      {hasAllocation(d.main) && <AvailRow label="🎟️ Main tickets" o={d.main} />}
      {hasAllocation(d.rap) && <AvailRow label="RAP" o={d.rap} />}
    </div>
  );
}

/** One availability line in the detail body — the same shape for main and RAP. */
function AvailRow({ label, o }: { label: string; o: DayObs }) {
  const s = availStatus(o);
  const pct = Math.round((o.available / o.capacity) * 100);
  return (
    <div className="rc-body-avail">
      {s.emoji} {label}: <strong>{o.available.toLocaleString()}</strong> of{" "}
      {o.capacity.toLocaleString()} ({pct}% · {s.label})
    </div>
  );
}

/* ── Desktop: continuous month scroll of rich cells ────────────────────────── */

function MonthGrid({
  mk,
  details,
  onSelect,
  selectedIso,
}: {
  mk: string;
  details: Map<string, DayDetail>;
  onSelect: (iso: string) => void;
  selectedIso: string | null;
}) {
  const first = new Date(`${mk}-01T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7; // Mon = 0
  const daysInMonth = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();

  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(<div key={`pad${i}`} className="rc-cell empty" />);
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${mk}-${String(day).padStart(2, "0")}`;
    const d = details.get(iso);
    if (!d) {
      cells.push(
        <div key={iso} className="rc-cell empty">
          <div className="rc-daynum">{day}</div>
        </div>,
      );
      continue;
    }
    const accent = d.rap ? colour(d.rap.available, d.rap.capacity) : undefined;
    cells.push(
      <div
        key={iso}
        className={"rc-cell" + (selectedIso === iso ? " sel" : "")}
        style={accent ? { borderLeftColor: accent } : undefined}
        onClick={() => onSelect(iso)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(iso);
          }
        }}
      >
        <div className="rc-daynum">{day}</div>
        <CellContent d={d} />
      </div>,
    );
  }

  return (
    <div className="rc-month">
      <div className="rc-grid">
        {DOW.map((l, i) => (
          <div key={i} className="rc-dow">
            {l}
          </div>
        ))}
        {cells}
      </div>
    </div>
  );
}

/** Prev/next month header, shared by desktop and mobile. */
function MonthNav({
  month,
  onPrev,
  onNext,
  canPrev,
  canNext,
}: {
  month: string;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
}) {
  return (
    <div className="rc-nav">
      <button
        className="rc-nav-btn"
        onClick={onPrev}
        disabled={!canPrev}
        aria-label="Previous month"
      >
        ‹
      </button>
      <h2 className="rc-nav-label">{monthLabel(month)}</h2>
      <button
        className="rc-nav-btn"
        onClick={onNext}
        disabled={!canNext}
        aria-label="Next month"
      >
        ›
      </button>
    </div>
  );
}

/* ── Mobile: day-by-day agenda list ────────────────────────────────────────── */

function Agenda({ details }: { details: Map<string, DayDetail> }) {
  const isos = [...details.keys()].sort();
  return (
    <div className="rc-agenda">
      {isos.map((iso) => {
        const d = details.get(iso)!;
        const event = d.event ? getEventIcon(d.event) : null;
        return (
          <div className="rc-agenda-day" key={iso}>
            <div className="rc-agenda-date">
              {longDate(iso)}
              {event && <span className="rc-agenda-eventtag"> {event}</span>}
            </div>
            <DayBody d={d} />
          </div>
        );
      })}
    </div>
  );
}

/* ── Tap sheet, pinned to the bottom (desktop grid) ────────────────────────── */

function DaySheet({ d, onClose }: { d: DayDetail; onClose: () => void }) {
  return (
    <div className="day-sheet" role="status" aria-live="polite">
      <div className="day-sheet-inner">
        <div className="day-sheet-head">
          <strong>{longDate(d.iso)}</strong>
          <button className="detail-close" onClick={onClose} aria-label="Close detail">
            ×
          </button>
        </div>
        <DayBody d={d} />
      </div>
    </div>
  );
}

/* ── Top level ─────────────────────────────────────────────────────────────── */

export function ParkCalendar({
  main,
  rap,
  hours,
  month,
  loading,
  onPrev,
  onNext,
  canPrev,
  canNext,
}: {
  main: ProductFile | null;
  rap: ProductFile | null;
  hours: HoursFile | null;
  month: string;
  loading?: boolean;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
}) {
  const isDesktop = useMediaQuery("(min-width: 820px)");
  const [selected, setSelected] = useState<string | null>(null);
  // A tapped day belongs to the current month — clear it when navigating away.
  useEffect(() => setSelected(null), [month]);

  const details = mergeDetails(main, rap, hours);
  const selDay = selected ? details.get(selected) ?? null : null;

  return (
    <>
      <MonthNav
        month={month}
        onPrev={onPrev}
        onNext={onNext}
        canPrev={canPrev}
        canNext={canNext}
      />
      {loading ? (
        <div className="page-meta">Loading…</div>
      ) : details.size === 0 ? (
        <div className="empty">No data for {monthLabel(month)}.</div>
      ) : isDesktop ? (
        <MonthGrid
          mk={month}
          details={details}
          selectedIso={selected}
          onSelect={(iso) => setSelected((prev) => (prev === iso ? null : iso))}
        />
      ) : (
        <Agenda details={details} />
      )}
      {isDesktop && selDay && <DaySheet d={selDay} onClose={() => setSelected(null)} />}
    </>
  );
}
