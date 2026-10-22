// Check a park end to end against its live sources, without wrangler dev (whose
// bundled workerd crashes on macOS with a kj "addrlen" fault once the worker
// fetches anything). Runs the worker's own code in Node with a Map standing in
// for R2: the ride catalog build, one live queue read, and the opening hours.
//
//   npm run check:park -- <park_key> [park_key...]
//
// Attractions.io parks only for the catalog and queue steps; any park for hours.
import { PARKS, parkTimeZone, type AttractionsConfig } from "../src/config";
import { fetchHours } from "../src/hours";
import { fetchLiveQueues } from "../src/queues";
import { rebuildCatalog, type RideCatalog } from "../src/rides";

const store = new Map<string, string>();
const bucket = {
  async get(k: string) {
    const v = store.get(k);
    return v == null ? null : { json: async () => JSON.parse(v), text: async () => v };
  },
  async put(k: string, v: string) {
    store.set(k, v);
  },
} as unknown as R2Bucket;

const keys = process.argv.slice(2);
if (!keys.length) {
  console.error("usage: npm run check:park -- <park_key> [park_key...]");
  process.exit(1);
}
for (const key of keys) {
  const park = PARKS.find((p) => p.key === key);
  if (!park) {
    console.log(`\n== ${key}: not in src/config.ts PARKS`);
    continue;
  }
  const tz = parkTimeZone(park);
  console.log(`\n== ${key} (${tz})`);

  if (park.queue?.kind === "attractions") {
    const q = park.queue as AttractionsConfig;
    const cat = (await rebuildCatalog(bucket, key, q, Date.now())) as RideCatalog | null;
    const items = Object.values(cat?.items ?? {});
    const groups = [...new Set(items.map((i) => i.group).filter(Boolean))];
    console.log(
      `   catalog: ${items.length} rides, ${Object.keys(cat?.queueLines ?? {}).length} queue lines, ` +
        `groupBy ${cat?.groupBy ?? "-"}${cat ? "" : "  <- FAILED (bad key, or bundle text this code can't read)"}`,
    );
    console.log(`   groups: ${groups.slice(0, 8).join(" | ") || "(none: everything under Other)"}`);
    console.log(`   names: ${items.slice(0, 6).map((i) => i.name).join(" | ")}`);

    const live = await fetchLiveQueues(q, cat, tz, null);
    const day = new Date().toISOString().slice(0, 10);
    const local = (m: number) =>
      new Date(Date.parse(`${day}T00:00:00Z`) + m * 60_000).toLocaleTimeString("en-GB", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
      });
    const running = Object.values(live.snapshot).filter((o) => o.isOpen && o.isOperational).length;
    console.log(
      `   live: ok=${live.ok} http=${live.httpStatus} lines=${live.linesSeen} running=${running} ` +
        `window=${live.resort ? `${local(live.resort.open)}-${local(live.resort.close)} local` : "none (closed today?)"}`,
    );
  } else if (park.queue) {
    console.log(`   queue: ${park.queue.kind} backend - not covered here; check /queues/${key}/latest.json after deploy`);
  }

  if (park.openingHours) {
    const h = await fetchHours(park.openingHours);
    const days = Object.entries(h.snapshot)
      .sort()
      .slice(0, 4)
      .map(
        ([d, v]) =>
          `${d} ${v.locations.map((l) => l.hours).join(" / ")}${v.event ? ` [${v.event}]` : ""}`,
      );
    console.log(`   hours: ok=${h.ok} http=${h.httpStatus} days=${h.datesSeen}`);
    for (const d of days) console.log(`      ${d}`);
  } else {
    console.log("   hours: none configured");
  }
}
