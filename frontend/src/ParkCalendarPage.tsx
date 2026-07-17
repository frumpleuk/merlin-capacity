import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { type HoursFile, loadHours, loadProduct, type ProductFile } from "./api";
import { findPark, PARK_HOME } from "./catalog";
import { ParkCalendar } from "./ParkCalendar";

interface ParkData {
  main: ProductFile | null;
  rap: ProductFile | null;
  hours: HoursFile | null;
}

export function ParkCalendarPage() {
  const { park } = useParams();
  const parkDef = findPark(park);

  // undefined = loading, else the three merged files (any may be null)
  const [data, setData] = useState<ParkData | undefined>(undefined);

  useEffect(() => {
    if (!parkDef) return;
    setData(undefined);
    let alive = true;
    const tick = async () => {
      const [main, rap, hours] = await Promise.all([
        loadProduct(park!, "main"),
        loadProduct(park!, "rap"),
        loadHours(park!),
      ]);
      if (alive) setData({ main, rap, hours });
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [park, parkDef]);

  if (!parkDef) return <Navigate to={PARK_HOME} replace />;

  if (data === undefined) {
    return (
      <main>
        <div className="page-meta">Loading…</div>
      </main>
    );
  }

  const stamps = [data.main, data.rap, data.hours]
    .map((f) => f?.generated_at)
    .filter(Boolean)
    .sort();
  const updated = stamps.at(-1);

  return (
    <main className="rc-main">
      {updated && (
        <div className="page-meta">
          Updated {new Date(updated).toLocaleString("en-GB")}.
        </div>
      )}
      <ParkCalendar main={data.main} rap={data.rap} hours={data.hours} />
    </main>
  );
}
