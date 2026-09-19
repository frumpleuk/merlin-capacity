// Draw the park under the Food tab's pins. Tiles would mean a map library and
// a request per tile per visitor, so instead we bake one small vector basemap
// per park from OpenStreetMap at authoring time and serve it as a static file.
//
//   node scripts/menus/basemap.mjs [park_key...]
//        -> frontend/public/basemaps/<park_key>.json
//
// The data is © OpenStreetMap contributors, ODbL. The map on the page credits
// them; keep that credit if you change the drawing.
import fs from "node:fs";
import path from "node:path";
import { PARK_DIRS, REPO, ROOT, venues } from "./lib.mjs";

const OUT_DIR = path.join(REPO, "frontend/public/basemaps");
const OVERPASS = "https://overpass-api.de/api/interpreter";
const UA = "merlin-capacity/0.1 (themeparks.frumple.co.uk)";
const MARGIN_M = 120; // beyond the outermost venue, so the park has edges
const TOLERANCE_M = 3; // simplification: finer than anything the map can show

/** What we draw, in the order it stacks. Everything else is dropped. */
const LAYER = (tags) => {
  if (tags.natural === "water" || tags.waterway) return "water";
  if (tags.natural === "wood" || tags.landuse === "forest" || tags.natural === "scrub") return "wood";
  if (tags.building) return "building";
  if (tags.highway) {
    if (["footway", "path", "pedestrian", "steps", "corridor"].includes(tags.highway)) return "path";
    if (["service", "unclassified", "tertiary", "residential", "track"].includes(tags.highway)) return "road";
  }
  return null;
};

/** Douglas-Peucker with the tolerance in metres. The park is small enough that
 *  a flat metre plane about its own latitude is exact for this. */
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const lat0 = points[0][0];
  const k = Math.cos((lat0 * Math.PI) / 180);
  const flat = points.map(([lat, lon]) => [(lon - points[0][1]) * k * 111_320, (lat - lat0) * 111_320]);
  const perpendicular = (i, a, b) => {
    const [px, py] = flat[i];
    const [ax, ay] = flat[a];
    const [bx, by] = flat[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return Math.hypot(px - ax, py - ay);
    return Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
  };
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let far = -1;
    let best = tolerance;
    for (let k = i + 1; k < j; k++) {
      const d = perpendicular(k, i, j);
      if (d > best) {
        best = d;
        far = k;
      }
    }
    if (far > 0) {
      keep[far] = true;
      stack.push([i, far], [far, j]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const round = (n) => +n.toFixed(5); // ~1.1m

async function overpass(bbox) {
  const [s, w, n, e] = bbox;
  const box = `(${s},${w},${n},${e})`;
  const query = `[out:json][timeout:120];(
    way["highway"]${box};
    way["natural"]${box};
    way["waterway"]${box};
    way["landuse"]${box};
    way["building"]${box};
  );out geom;`;
  const resp = await fetch(`${OVERPASS}?data=${encodeURIComponent(query)}`, {
    headers: { "user-agent": UA },
  });
  if (!resp.ok) throw new Error(`overpass ${resp.status}`);
  return resp.json();
}

const wanted = process.argv.slice(2);
fs.mkdirSync(OUT_DIR, { recursive: true });

for (const [key, dir] of Object.entries(PARK_DIRS)) {
  if (wanted.length && !wanted.includes(key)) continue;
  const parkDir = path.join(ROOT, dir);
  if (!fs.existsSync(parkDir)) continue;
  const pts = venues(parkDir)
    .map((v) => v.poi)
    .filter((p) => p.lat != null && p.lon != null);
  // Hotel restaurants sit well outside the park; the map is the park, so the
  // box comes from the middle 90% of venues.
  const mid = (values) => {
    const s = [...values].sort((a, b) => a - b);
    const lo = s[Math.floor(s.length * 0.05)];
    const hi = s[Math.ceil(s.length * 0.95) - 1];
    return [lo, hi];
  };
  const [minLat, maxLat] = mid(pts.map((p) => p.lat));
  const [minLon, maxLon] = mid(pts.map((p) => p.lon));
  const dLat = MARGIN_M / 111_320;
  const dLon = MARGIN_M / (111_320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180));
  const bbox = [minLat - dLat, minLon - dLon, maxLat + dLat, maxLon + dLon];

  const data = await overpass(bbox);
  const features = [];
  for (const el of data.elements ?? []) {
    if (!el.geometry?.length) continue;
    const layer = LAYER(el.tags ?? {});
    if (!layer) continue;
    const pointsRaw = el.geometry.map((g) => [g.lat, g.lon]);
    const points = simplify(pointsRaw, TOLERANCE_M).map(([a, b]) => [round(a), round(b)]);
    if (points.length < 2) continue;
    const closed =
      points.length > 2 &&
      points[0][0] === points[points.length - 1][0] &&
      points[0][1] === points[points.length - 1][1];
    features.push({ l: layer, c: closed ? 1 : 0, p: points.flat() });
  }
  // Biggest shapes first so a building never hides under a wood.
  const order = { wood: 0, water: 1, building: 2, road: 3, path: 4 };
  features.sort((a, b) => order[a.l] - order[b.l]);

  const out = path.join(OUT_DIR, `${key}.json`);
  fs.writeFileSync(
    out,
    JSON.stringify({
      attribution: "© OpenStreetMap contributors",
      licence: "ODbL",
      bbox,
      features,
    }) + "\n",
  );
  const counts = features.reduce((m, f) => ({ ...m, [f.l]: (m[f.l] ?? 0) + 1 }), {});
  console.log(
    `${key}: ${features.length} shapes (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}), ` +
      `${(fs.statSync(out).size / 1024).toFixed(0)}KB`,
  );
}
