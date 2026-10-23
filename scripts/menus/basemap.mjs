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
import { ALL_PARK_DIRS, REPO, parkDir, venues } from "./lib.mjs";

const OUT_DIR = path.join(REPO, "frontend/public/basemaps");
const OVERPASS = "https://overpass-api.de/api/interpreter";
const UA = "merlin-capacity/0.1 (themeparks.frumple.co.uk)";
const MARGIN_M = 120; // beyond the outermost venue, so the park has edges
const TOLERANCE_M = 3; // simplification: finer than anything the map can show

/** What we draw, in the order it stacks. Everything else is dropped. A
 *  `waterway` is a line (a river, a stream), drawn as one; `water` and `wood`
 *  are areas. */
const LAYER = (tags) => {
  if (tags.waterway && tags.waterway !== "riverbank") return "stream";
  if (tags.natural === "water" || tags.waterway === "riverbank") return "water";
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

const same = (a, b) => a[0] === b[0] && a[1] === b[1];

/** Join a multipolygon's member ways into closed rings. A big lake is mapped
 *  as a relation whose outline is split over several open ways; filled one by
 *  one, each piece draws a straight chord across the park. Pieces that never
 *  close (cut off by the query box) are dropped. */
function rings(ways) {
  const open = ways.map((w) => [...w]);
  const out = [];
  while (open.length) {
    let ring = open.shift();
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const w = open[i];
        const end = ring[ring.length - 1];
        if (same(end, w[0])) ring = ring.concat(w.slice(1));
        else if (same(end, w[w.length - 1])) ring = ring.concat([...w].reverse().slice(1));
        else if (same(ring[0], w[w.length - 1])) ring = w.concat(ring.slice(1));
        else if (same(ring[0], w[0])) ring = [...w].reverse().concat(ring.slice(1));
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length > 3 && same(ring[0], ring[ring.length - 1])) out.push(ring);
  }
  return out;
}

async function overpass(bbox) {
  const [s, w, n, e] = bbox;
  const box = `(${s},${w},${n},${e})`;
  const query = `[out:json][timeout:120];(
    way["highway"]${box};
    way["natural"]${box};
    way["waterway"]${box};
    way["landuse"]${box};
    way["building"]${box};
    relation["type"="multipolygon"]["natural"~"^(water|wood|scrub)$"]${box};
    relation["type"="multipolygon"]["landuse"="forest"]${box};
  );out geom;`;
  // Overpass sheds load with 429, 502 and 504: wait and try again.
  for (let attempt = 1; ; attempt++) {
    const resp = await fetch(`${OVERPASS}?data=${encodeURIComponent(query)}`, {
      headers: { "user-agent": UA },
    });
    if (resp.ok) return resp.json();
    if (![429, 502, 504].includes(resp.status) || attempt === 5) throw new Error(`overpass ${resp.status}`);
    await new Promise((r) => setTimeout(r, attempt * 20_000));
  }
}

const wanted = process.argv.slice(2);
fs.mkdirSync(OUT_DIR, { recursive: true });

for (const key of Object.keys(ALL_PARK_DIRS)) {
  if (wanted.length && !wanted.includes(key)) continue;
  const dir = parkDir(key);
  if (!fs.existsSync(dir)) continue;
  const pts = venues(dir)
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
  const AREAS = new Set(["wood", "water", "building"]);
  const tidy = (pts) => simplify(pts, TOLERANCE_M).map(([a, b]) => [round(a), round(b)]);
  for (const el of data.elements ?? []) {
    const layer = LAYER(el.tags ?? {});
    if (!layer) continue;
    if (el.type === "relation") {
      // Outer rings fill, inner rings (islands) cut holes: one feature with
      // every ring, drawn even-odd.
      const member = (role) =>
        (el.members ?? [])
          .filter((m) => m.type === "way" && m.geometry?.length && (m.role || "outer") === role)
          .map((m) => m.geometry.map((g) => [g.lat, g.lon]));
      const all = [...rings(member("outer")), ...rings(member("inner"))]
        .map(tidy)
        .filter((r) => r.length > 3);
      if (!all.length) continue;
      features.push({ l: layer, c: 1, p: all[0].flat(), ...(all.length > 1 ? { h: all.slice(1).map((r) => r.flat()) } : {}) });
      continue;
    }
    if (!el.geometry?.length) continue;
    const points = tidy(el.geometry.map((g) => [g.lat, g.lon]));
    if (points.length < 2) continue;
    const closed = points.length > 3 && same(points[0], points[points.length - 1]);
    // An open way tagged as an area is a piece of a relation's outline, drawn
    // with its relation above.
    if (AREAS.has(layer) && !closed) continue;
    features.push({ l: layer, c: closed ? 1 : 0, p: points.flat() });
  }
  // Biggest shapes first so a building never hides under a wood.
  const order = { wood: 0, water: 1, stream: 2, building: 3, road: 4, path: 5 };
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
