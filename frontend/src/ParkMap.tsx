import { useEffect, useMemo, useState } from "react";

export interface MapPoint {
  slug: string;
  name: string;
  area?: string | null;
  /** We have a menu with prices for this one; hollow pins are places we know
   *  about from the park's app but haven't photographed. */
  priced?: boolean;
  lat: number | null;
  lon: number | null;
}
export interface MapArea {
  name: string;
  lat: number;
  lon: number;
}
/** frontend/public/basemaps/<park>.json, baked from OpenStreetMap by
 *  scripts/menus/basemap.mjs. Fetched rather than bundled: it's ~70KB a park
 *  and only the park you're looking at is needed. */
interface Basemap {
  attribution: string;
  features: { l: "wood" | "water" | "building" | "road" | "path"; c: 0 | 1; p: number[] }[];
}

/** A park is a few hundred metres across, so a flat projection is exact
 *  enough: longitude shrinks by cos(latitude), everything else is a scale. */
export function ParkMap({
  park,
  venues,
  water,
  areas,
  matched,
  focus,
  onPick,
}: {
  park: string;
  venues: MapPoint[];
  water: MapPoint[];
  areas: MapArea[];
  /** Slugs passing the search and filters; the rest fade back. */
  matched: Set<string>;
  focus?: string;
  onPick: (slug: string) => void;
}) {
  const W = 320;
  const H = 300;
  const [base, setBase] = useState<Basemap | null>(null);

  useEffect(() => {
    let live = true;
    setBase(null);
    fetch(`/basemaps/${park}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => live && setBase(b))
      .catch(() => {}); // no basemap for this park: the pins alone still work
    return () => {
      live = false;
    };
  }, [park]);

  const place = useMemo(() => {
    const pts = [...venues, ...water].flatMap((p) =>
      p.lat != null && p.lon != null ? [{ lat: p.lat, lon: p.lon }] : [],
    );
    if (!pts.length) return null;
    // Bounds come from the pins, trimmed: the resort's hotel restaurants sit a
    // long way outside the park and would squash it into a corner. They fall
    // off the edge of the map, and stay in the list.
    const span = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const at = (f: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(f * (sorted.length - 1))))];
      const lo = at(0.05);
      const hi = at(0.95);
      const room = (hi - lo) * 0.08;
      return [lo - room, hi + room] as const;
    };
    const [minLat, maxLat] = span(pts.map((p) => p.lat));
    const [minLon, maxLon] = span(pts.map((p) => p.lon));
    const midLat = (minLat + maxLat) / 2;
    const k = Math.cos((midLat * Math.PI) / 180);
    const w = (maxLon - minLon) * k || 1e-6;
    const h = maxLat - minLat || 1e-6;
    const pad = 18;
    const scale = Math.min((W - pad * 2) / w, (H - pad * 2) / h);
    const offX = (W - w * scale) / 2;
    const offY = (H - h * scale) / 2;
    return {
      x: (lon: number) => offX + (lon - minLon) * k * scale,
      y: (lat: number) => offY + (maxLat - lat) * scale,
    };
  }, [venues, water]);

  // The basemap's shapes as SVG paths, in the same projection.
  const shapes = useMemo(() => {
    if (!base || !place) return [];
    return base.features.map((f, i) => {
      let d = "";
      for (let n = 0; n < f.p.length; n += 2) {
        d += `${n ? "L" : "M"}${place.x(f.p[n + 1]).toFixed(1)} ${place.y(f.p[n]).toFixed(1)}`;
      }
      return { key: `${f.l}-${i}`, layer: f.l, d: f.c ? d + "Z" : d };
    });
  }, [base, place]);

  // Label an area only where there is food, and only where the label won't sit
  // on top of one already drawn — a park map is unreadable otherwise.
  const labels = useMemo(() => {
    if (!place) return [];
    const wanted = new Set(venues.map((v) => v.area).filter(Boolean));
    const drawn: { x: number; y: number }[] = [];
    return areas
      .filter((a) => wanted.has(a.name))
      .map((a) => ({ ...a, x: place.x(a.lon), y: place.y(a.lat) }))
      .filter((a) => a.x > 6 && a.x < W - 6 && a.y > 8 && a.y < H - 4)
      .filter((a) => {
        if (drawn.some((d) => Math.abs(d.x - a.x) < 46 && Math.abs(d.y - a.y) < 11)) return false;
        drawn.push(a);
        return true;
      });
  }, [areas, venues, place]);

  if (!place) return null;

  return (
    <figure className="fd-map-wrap">
      <svg className="fd-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Map of the park's food outlets">
        {/* The basemap covers more ground than the pins, so clip it to the card. */}
        <clipPath id="fd-map-clip">
          <rect x="0" y="0" width={W} height={H} rx="8" />
        </clipPath>
        <g clipPath="url(#fd-map-clip)">
          {shapes.map((s) => (
            <path key={s.key} className={`fd-shape fd-${s.layer}`} d={s.d} />
          ))}
          {labels.map((a) => (
            <text key={a.name} className="fd-map-area" x={a.x} y={a.y - 7} textAnchor="middle">
              {a.name}
            </text>
          ))}
          {water
            .filter((p) => p.lat != null)
            .map((p) => (
              <circle key={p.slug} className="fd-map-water" cx={place.x(p.lon!)} cy={place.y(p.lat!)} r={3}>
                <title>{p.name} — free water refill</title>
              </circle>
            ))}
          {venues
            .filter((p) => p.lat != null)
            .map((p) => (
              <circle
                key={p.slug}
                className={
                  "fd-map-pin" +
                  (p.priced === false ? " unseen" : "") +
                  (matched.has(p.slug) ? " on" : "") +
                  (focus === p.slug ? " focus" : "")
                }
                cx={place.x(p.lon!)}
                cy={place.y(p.lat!)}
                r={focus === p.slug ? 7 : p.priced === false ? 3.5 : 4.5}
                onClick={() => onPick(p.slug)}
              >
                <title>{p.name}</title>
              </circle>
            ))}
        </g>
      </svg>
      <figcaption className="fd-legend">
        <span className="fd-key fd-key-priced" /> prices
        <span className="fd-key fd-key-unseen" /> no menu yet
        <span className="fd-key fd-key-water" /> water refill
      </figcaption>
      {base && (
        <figcaption className="fd-map-credit">
          Map data{" "}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">
            © OpenStreetMap contributors
          </a>
        </figcaption>
      )}
    </figure>
  );
}
