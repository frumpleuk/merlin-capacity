import { useMemo } from "react";

export interface MapPoint {
  slug: string;
  name: string;
  area?: string | null;
  lat: number | null;
  lon: number | null;
}
export interface MapArea {
  name: string;
  lat: number;
  lon: number;
}

/** A park is a few hundred metres across, so a flat projection is exact enough:
 *  longitude shrinks by cos(latitude) and everything else is a straight scale.
 *  No tiles, no map library — the pins and the park's own area labels are the
 *  whole map, and they come from data we already hold. */
export function ParkMap({
  venues,
  water,
  areas,
  matched,
  focus,
  onPick,
}: {
  venues: MapPoint[];
  water: MapPoint[];
  areas: MapArea[];
  /** Slugs currently passing the search and filters; the rest fade back. */
  matched: Set<string>;
  focus?: string;
  onPick: (slug: string) => void;
}) {
  const W = 320;
  const H = 300;

  const place = useMemo(() => {
    const pts = [...venues, ...water].flatMap((p) =>
      p.lat != null && p.lon != null ? [{ lat: p.lat, lon: p.lon }] : [],
    );
    if (!pts.length) return null;
    // Bounds come from the pins alone: an area label way off at a hotel would
    // otherwise squash the park into a corner.
    const lats = pts.map((p) => p.lat);
    const lons = pts.map((p) => p.lon);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const midLat = (minLat + maxLat) / 2;
    const k = Math.cos((midLat * Math.PI) / 180);
    const w = (maxLon - minLon) * k || 1e-6;
    const h = maxLat - minLat || 1e-6;
    // Fit the park in the box, keeping its shape, with room for labels.
    const pad = 18;
    const scale = Math.min((W - pad * 2) / w, (H - pad * 2) / h);
    const offX = (W - w * scale) / 2;
    const offY = (H - h * scale) / 2;
    return {
      x: (lon: number) => offX + (lon - minLon) * k * scale,
      y: (lat: number) => offY + (maxLat - lat) * scale,
    };
  }, [venues, water, areas]);

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
    <svg className="fd-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Map of the park's food outlets">
      {labels.map((a) => (
        <text key={a.name} className="fd-map-area" x={a.x} y={a.y - 7} textAnchor="middle">
          {a.name}
        </text>
      ))}
      {water
        .filter((p) => p.lat != null)
        .map((p) => (
          <circle key={p.slug} className="fd-map-water" cx={place.x(p.lon!)} cy={place.y(p.lat!)} r={2.5}>
            <title>{p.name} (water refill)</title>
          </circle>
        ))}
      {venues
        .filter((p) => p.lat != null)
        .map((p) => {
          const on = matched.has(p.slug);
          return (
            <circle
              key={p.slug}
              className={"fd-map-pin" + (on ? " on" : "") + (focus === p.slug ? " focus" : "")}
              cx={place.x(p.lon!)}
              cy={place.y(p.lat!)}
              r={focus === p.slug ? 7 : 4.5}
              onClick={() => onPick(p.slug)}
            >
              <title>{p.name}</title>
            </circle>
          );
        })}
    </svg>
  );
}
