import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import {
  loadParkIndex,
  loadPollStatus,
  loadProduct,
  loadProductRange,
  type PollStatus,
  type ProductFile,
} from "./api";
import { DEFAULT_PATH, findPark } from "./catalog";
import { DetailBar, ProductCalendar } from "./Heatmap";
import { UpdateMeta } from "./UpdateMeta";

export function CalendarPage() {
  const { park, product } = useParams();
  const parkDef = findPark(park);
  const productDef = parkDef?.products.find((pr) => pr.key === product);

  const today = new Date().toISOString().slice(0, 10);
  // undefined = loading, null = no data for this product yet
  const [file, setFile] = useState<ProductFile | null | undefined>(undefined);
  const [status, setStatus] = useState<PollStatus | null>(null);
  // Default the selection to today, so the detail bar opens on the current day.
  const [selected, setSelected] = useState<string | null>(today);

  useEffect(() => {
    if (!parkDef || !productDef) return;
    setSelected(today);
    setFile(undefined);
    let alive = true;
    const tick = async () => {
      // Prefer the merged per-month files (history + forward); fall back to the
      // forward-only file if the park index isn't available yet.
      const index = await loadParkIndex(park!);
      const [f, s] = await Promise.all([
        index
          ? loadProductRange(park!, product!, index)
          : loadProduct(park!, product!),
        loadPollStatus(park!, product!),
      ]);
      if (alive) {
        setFile(f);
        setStatus(s);
      }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [park, product, parkDef, productDef]);

  if (!parkDef || !productDef) return <Navigate to={DEFAULT_PATH} replace />;

  if (file === undefined) {
    return (
      <main>
        <div className="page-meta">Loading…</div>
      </main>
    );
  }
  if (file === null) {
    return (
      <main>
        <div className="empty">No data yet for {productDef.label}.</div>
      </main>
    );
  }

  const selDay = selected ? file.days[selected] ?? null : null;

  return (
    <>
      <main className={selDay ? "with-bar" : undefined}>
        <UpdateMeta status={status} />
        <ProductCalendar
          file={file}
          selectedIso={selected}
          onSelect={(iso) => setSelected((prev) => (prev === iso ? null : iso))}
        />
      </main>
      {selected && selDay && (
        <DetailBar
          label={productDef.label}
          iso={selected}
          o={selDay}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
