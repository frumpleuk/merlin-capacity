import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import {
  loadQueueDay,
  loadProductMonth,
  loadQueueIndex,
  loadSpecialDays,
  type QueueDayFile,
  type DayObs,
  type QueueIndex,
  type SpecialDaysFile,
} from "./api";
import { findPark, PARK_HOME } from "./catalog";
import { DateNav, QueueList } from "./Queues";

const today = () => new Date().toISOString().slice(0, 10);

/** Shift a 'YYYY-MM-DD' by whole days (UTC-safe). */
function addDays(date: string, delta: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + delta * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function QueuesPage() {
  const { park, date: dateParam } = useParams();
  const parkDef = findPark(park);
  const navigate = useNavigate();
  const date = dateParam ?? today();

  const [bounds, setBounds] = useState<QueueIndex | null>(null);
  const [file, setFile] = useState<QueueDayFile | null | undefined>(undefined); // undefined = loading
  const [special, setSpecial] = useState<SpecialDaysFile | null>(null);
  const [tickets, setTickets] = useState<DayObs | undefined>(undefined);
  const [rap, setRap] = useState<DayObs | undefined>(undefined);

  useEffect(() => {
    if (!parkDef) return;
    let alive = true;
    loadQueueIndex(park!).then((b) => alive && setBounds(b));
    // Whole-horizon file, refreshed daily — one fetch per park covers every date
    // the nav can reach, so it doesn't reload as you page between days.
    setSpecial(null);
    loadSpecialDays(park!).then((f) => alive && setSpecial(f));
    return () => {
      alive = false;
    };
  }, [park, parkDef]);

  // Load the day's file; refresh the live (today) view on a timer.
  useEffect(() => {
    if (!parkDef) return;
    setFile(undefined);
    setTickets(undefined); // or the previous day's figure shows while loading
    setRap(undefined);
    let alive = true;
    const tick = async () => {
      const f = await loadQueueDay(park!, date);
      if (alive) setFile(f);
    };
    tick();
    // Ticket availability for the same day, from the month file the calendar
    // already serves. Queue-only parks 404 to null and show nothing.
    loadProductMonth(park!, "main", date.slice(0, 7)).then((f) => {
      if (alive) setTickets(f?.days[date]);
    });
    loadProductMonth(park!, "rap", date.slice(0, 7)).then((f) => {
      if (alive) setRap(f?.days[date]);
    });
    const isToday = date === today();
    const id = isToday ? setInterval(tick, 30_000) : undefined;
    return () => {
      alive = false;
      if (id) clearInterval(id);
    };
  }, [park, parkDef, date]);

  if (!parkDef) return <Navigate to={PARK_HOME} replace />;

  // Nav base: date param drops off for "today" so the URL stays clean.
  const go = (d: string) =>
    navigate(d === today() ? `/${park}/queues` : `/${park}/queues/${d}`);
  const canPrev = !bounds || date > bounds.minDate;
  const canNext = date < today();

  // Time to hold each still-open sparkline out to, on the samples' UTC-minute
  // axis: now (today) or the day file's final write (a past day). This used to
  // prefer the last poll time, which stopped the line short when the collector
  // had stalled; with no liveness signal published any more, today's line runs
  // to now regardless.
  const isToday = date === today();
  const asOfIso = isToday ? new Date().toISOString() : file?.generated_at;
  const asOf = asOfIso
    ? Math.floor((Date.parse(asOfIso) - Date.parse(`${date}T00:00:00Z`)) / 60_000)
    : undefined;

  return (
    <main className="rc-main">
      <DateNav
        date={date}
        onPrev={() => go(addDays(date, -1))}
        onNext={() => go(addDays(date, 1))}
        canPrev={canPrev}
        canNext={canNext}
      />
      <QueueList
        file={file ?? null}
        date={date}
        loading={file === undefined}
        asOf={asOf}
        special={special?.days[date]}
        tickets={tickets}
        rap={rap}
      />
    </main>
  );
}
