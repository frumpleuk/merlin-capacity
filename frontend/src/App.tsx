import { useEffect, useState } from "react";
import { loadProducts, type ProductFile } from "./api";
import { ProductCalendar } from "./Heatmap";

export function App() {
  const [files, setFiles] = useState<ProductFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const updated = files?.length
    ? files
        .map((f) => f.generated_at)
        .sort()
        .at(-1)
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
      <main>
        {error && <div className="err">{error}</div>}
        {files?.map((f) => (
          <ProductCalendar key={f.product} file={f} />
        ))}
      </main>
    </>
  );
}
