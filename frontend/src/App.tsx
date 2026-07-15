import { useEffect, useState } from "react";
import { loadProducts, type Product, type ProductFile } from "./api";
import { DetailBar, ProductCalendar } from "./Heatmap";

type Selection = { product: Product; iso: string } | null;

export function App() {
  const [files, setFiles] = useState<ProductFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const f = await loadProducts();
        if (!alive) return;
        if (!f.length) throw new Error("no calendar data yet — has the poller run?");
        setFiles(f);
        setError(null);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const onSelect = (product: Product, iso: string) =>
    setSel((prev) =>
      prev && prev.product === product && prev.iso === iso ? null : { product, iso },
    );

  const updated = files?.length
    ? files
        .map((f) => f.generated_at)
        .sort()
        .at(-1)
    : null;

  // Resolve the selected day against the latest data (so the bar updates live).
  const selDay = sel
    ? files?.find((f) => f.product === sel.product)?.days[sel.iso] ?? null
    : null;

  return (
    <>
      <header>
        <h1>Merlin Capacity — Alton Towers</h1>
        <div className="meta">
          {error
            ? "—"
            : updated
              ? `Updated ${new Date(updated).toLocaleString("en-GB")}`
              : "Loading…"}
        </div>
      </header>
      <main className={selDay ? "with-bar" : undefined}>
        {error && <div className="err">{error}</div>}
        {files?.map((f) => (
          <ProductCalendar
            key={f.product}
            file={f}
            selectedIso={sel?.product === f.product ? sel.iso : null}
            onSelect={onSelect}
          />
        ))}
      </main>
      {sel && selDay && (
        <DetailBar
          product={sel.product}
          iso={sel.iso}
          o={selDay}
          onClose={() => setSel(null)}
        />
      )}
    </>
  );
}
