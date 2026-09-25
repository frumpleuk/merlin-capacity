import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import {
  type HoursFile,
  loadHoursMonth,
  loadParkIndex,
  loadAnomalies,
  loadProductMonth,
  loadRestrictions,
  loadSpecialDays,
  type AnomalyKind,
  type ParkIndex,
  type ProductFile,
  type RestrictionsFile,
  type SpecialDaysFile,
} from "./api";
import { findPark, PARK_HOME } from "./catalog";
import { ParkCalendar } from "./ParkCalendar";

interface MonthData {
  main: ProductFile | null;
  rap: ProductFile | null;
  hours: HoursFile | null;
  /** A season sold under its own package (Chessington Christmas). Absent for
   *  parks without one, which just 404s to null. */
  season: ProductFile | null;
  /** One-off ticketed events (ParkDef.events), in catalog order. A month the
   *  event doesn't fall in 404s to null and contributes nothing. */
  events: { label: string; file: ProductFile | null }[];
}

/** The special-days file covers the whole horizon in one object; the calendar
 *  renders one month, and a buyout CREATES a calendar row, so an unfiltered file
 *  would spill other months' dates into the mobile agenda. */
function specialForMonth(
  file: SpecialDaysFile | null,
  month: string,
): SpecialDaysFile | null {
  if (!file) return null;
  const days = Object.fromEntries(
    Object.entries(file.days).filter(([iso]) => iso.startsWith(month)),
  );
  return Object.keys(days).length ? { ...file, days } : null;
}

/** Same reasoning as specialForMonth: the restriction calendar covers ~15
 *  months in one object and a restricted date CREATES a calendar row, so an
 *  unfiltered file would spill next spring's blackouts into this month's agenda. */
function restrictionsForMonth(
  file: RestrictionsFile | null,
  month: string,
): RestrictionsFile | null {
  if (!file) return null;
  const days = Object.fromEntries(
    Object.entries(file.days).filter(([iso]) => iso.startsWith(month)),
  );
  return Object.keys(days).length ? { ...file, days } : null;
}

const currentMonth = () => new Date().toISOString().slice(0, 7);

/** Shift a 'YYYY-MM' by whole months (UTC-safe). */
function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

export function ParkCalendarPage() {
  const { park } = useParams();
  const parkDef = findPark(park);

  const [month, setMonth] = useState(currentMonth);
  const [bounds, setBounds] = useState<ParkIndex | null>(null);
  // undefined = loading, else the three per-month files (any may be null)
  const [data, setData] = useState<MonthData | undefined>(undefined);
  const [special, setSpecial] = useState<SpecialDaysFile | null>(null);
  const [anomalies, setAnomalies] = useState<
    Record<string, { kind: AnomalyKind; note: string }>
  >({});
  const [restrictions, setRestrictions] = useState<RestrictionsFile | null>(null);

  // Reset to the current month and refetch bounds whenever the park changes.
  useEffect(() => {
    if (!parkDef || parkDef.queueOnly) return;
    setMonth(currentMonth());
    setBounds(null);
    setSpecial(null);
    setAnomalies({});
    setRestrictions(null);
    let alive = true;
    loadParkIndex(park!).then((b) => alive && setBounds(b));
    // One file for the whole horizon, refreshed daily — fetched per park, not
    // per month, and sliced to the displayed month at render.
    loadSpecialDays(park!).then((f) => alive && setSpecial(f));
    // Whole-horizon, like the special days: one fetch per park, filtered at
    // render. Annotates existing cells, so it needs no month slicing.
    loadAnomalies(park!).then((a) => alive && setAnomalies(a));
    // Estate-wide and identical for all four Merlin parks, so it's one file for
    // the whole horizon like the special days — sliced to the month at render.
    // The independents run their own pass schemes; nothing to show for them.
    if (parkDef.merlinPass) {
      loadRestrictions().then((f) => alive && setRestrictions(f));
    }
    return () => {
      alive = false;
    };
  }, [park, parkDef]);


  // Load the displayed month's files; refresh live months on a timer.
  useEffect(() => {
    if (!parkDef || parkDef.queueOnly) return;
    setData(undefined);
    let alive = true;
    const tick = async () => {
      const defs = parkDef.events ?? [];
      const [main, rap, hours, season, ...events] = await Promise.all([
        loadProductMonth(park!, "main", month),
        loadProductMonth(park!, "rap", month),
        loadHoursMonth(park!, month),
        loadProductMonth(park!, "season", month),
        ...defs.map((e) => loadProductMonth(park!, e.key, month)),
      ]);
      if (alive)
        setData({
          main,
          rap,
          hours,
          season,
          events: defs.map((e, i) => ({ label: e.label, file: events[i] })),
        });
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [park, parkDef, month]);

  if (!parkDef) return <Navigate to={PARK_HOME} replace />;
  // A queue-only park has no calendar — its home is the Queues tab.
  if (parkDef.queueOnly) return <Navigate to={`/${park}/queues`} replace />;

  const canPrev = !bounds || month > bounds.minMonth;
  const canNext = !bounds || month < bounds.maxMonth;

  return (
    <main className="rc-main">
      <ParkCalendar
        main={data?.main ?? null}
        rap={data?.rap ?? null}
        hours={data?.hours ?? null}
        season={data?.season ?? null}
        events={data?.events ?? []}
        special={specialForMonth(special, month)}
        anomalies={anomalies}
        restrictions={restrictionsForMonth(restrictions, month)}
        loading={data === undefined}
        month={month}
        onPrev={() => setMonth((m) => addMonths(m, -1))}
        onNext={() => setMonth((m) => addMonths(m, 1))}
        canPrev={canPrev}
        canNext={canNext}
      />
    </main>
  );
}
