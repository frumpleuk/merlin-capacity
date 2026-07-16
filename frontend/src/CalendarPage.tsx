import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { loadProduct, type ProductFile } from "./api";
import { DEFAULT_PATH, findPark } from "./catalog";
import { DetailBar, ProductCalendar } from "./Heatmap";

export function CalendarPage() {
  const { park, product } = useParams();
  const parkDef = findPark(park);
  const productDef = parkDef?.products.find((pr) => pr.key === product);

  // undefined = loading, null = no data for this product yet
  const [file, setFile] = useState<ProductFile | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!parkDef || !productDef) return;
    setSelected(null);
    setFile(undefined);
    let alive = true;
    const tick = async () => {
      const f = await loadProduct(park!, product!);
      if (alive) setFile(f);
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

  const dates = Object.keys(file.days);
  const total = dates.reduce((a, d) => a + (file.days[d].available || 0), 0);
  const selDay = selected ? file.days[selected] ?? null : null;

  return (
    <>
      <main className={selDay ? "with-bar" : undefined}>
        <div className="page-meta">
          Updated {new Date(file.generated_at).toLocaleString("en-GB")}.{" "}
          {dates.length} dates, {total.toLocaleString()} tickets available.
        </div>
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
