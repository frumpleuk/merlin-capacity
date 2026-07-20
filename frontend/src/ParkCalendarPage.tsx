import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import {
  type HoursFile,
  loadHoursMonth,
  loadParkIndex,
  loadPollStatus,
  loadProductMonth,
  mergeStatus,
  type ParkIndex,
  type PollStatus,
  type ProductFile,
} from "./api";
import { findPark, PARK_HOME } from "./catalog";
import { ParkCalendar } from "./ParkCalendar";
import { UpdateMeta } from "./UpdateMeta";

interface MonthData {
  main: ProductFile | null;
  rap: ProductFile | null;
  hours: HoursFile | null;
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
  const [status, setStatus] = useState<PollStatus | null>(null);

  // Reset to the current month and refetch bounds whenever the park changes.
  useEffect(() => {
    if (!parkDef) return;
    setMonth(currentMonth());
    setBounds(null);
    let alive = true;
    loadParkIndex(park!).then((b) => alive && setBounds(b));
    return () => {
      alive = false;
    };
  }, [park, parkDef]);

  // Calendar freshness = everything shown on this page, aggregated: main + RAP
  // availability plus opening hours / events.
  useEffect(() => {
    if (!parkDef) return;
    let alive = true;
    const tick = async () => {
      const [m, r, h] = await Promise.all([
        loadPollStatus(park!, "main"),
        loadPollStatus(park!, "rap"),
        loadPollStatus(park!, "hours"),
      ]);
      if (alive) setStatus(mergeStatus([m, r, h]));
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [park, parkDef]);

  // Load the displayed month's files; refresh live months on a timer.
  useEffect(() => {
    if (!parkDef) return;
    setData(undefined);
    let alive = true;
    const tick = async () => {
      const [main, rap, hours] = await Promise.all([
        loadProductMonth(park!, "main", month),
        loadProductMonth(park!, "rap", month),
        loadHoursMonth(park!, month),
      ]);
      if (alive) setData({ main, rap, hours });
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [park, parkDef, month]);

  if (!parkDef) return <Navigate to={PARK_HOME} replace />;

  const canPrev = !bounds || month > bounds.minMonth;
  const canNext = !bounds || month < bounds.maxMonth;

  return (
    <main className="rc-main">
      <UpdateMeta status={status} />
      <ParkCalendar
        main={data?.main ?? null}
        rap={data?.rap ?? null}
        hours={data?.hours ?? null}
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
