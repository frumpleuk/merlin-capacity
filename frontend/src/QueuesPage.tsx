import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import {
  loadPollStatus,
  loadQueueDay,
  loadQueueIndex,
  type PollStatus,
  type QueueDayFile,
  type QueueIndex,
} from "./api";
import { findPark, PARK_HOME } from "./catalog";
import { DateNav, QueueList } from "./Queues";
import { UpdateMeta } from "./UpdateMeta";

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
  const [status, setStatus] = useState<PollStatus | null>(null);

  useEffect(() => {
    if (!parkDef) return;
    let alive = true;
    loadQueueIndex(park!).then((b) => alive && setBounds(b));
    return () => {
      alive = false;
    };
  }, [park, parkDef]);

  // Load the day's file + poll status; refresh the live (today) view on a timer.
  useEffect(() => {
    if (!parkDef) return;
    setFile(undefined);
    let alive = true;
    const tick = async () => {
      const [f, s] = await Promise.all([
        loadQueueDay(park!, date),
        loadPollStatus(park!, "queues"),
      ]);
      if (alive) {
        setFile(f);
        setStatus(s);
      }
    };
    tick();
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
  // axis: the last poll (today) or the day file's final write (a past day).
  const isToday = date === today();
  const asOfIso = isToday ? status?.last_polled ?? new Date().toISOString() : file?.generated_at;
  const asOf = asOfIso
    ? Math.floor((Date.parse(asOfIso) - Date.parse(`${date}T00:00:00Z`)) / 60_000)
    : undefined;

  return (
    <main className="rc-main">
      <UpdateMeta status={status} />
      <DateNav
        date={date}
        onPrev={() => go(addDays(date, -1))}
        onNext={() => go(addDays(date, 1))}
        canPrev={canPrev}
        canNext={canNext}
      />
      <QueueList file={file ?? null} date={date} loading={file === undefined} asOf={asOf} />
    </main>
  );
}
