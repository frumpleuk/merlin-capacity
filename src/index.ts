import { allProducts, attractionsParks, dueProducts, PARKS, queueParks } from "./config";
import { rebuildMonthsFromD1, updateQueueIndex, writeQueueDayFile } from "./db";
import { refreshPackages } from "./discover";
import { runHoursPoll } from "./hours";
import { runPoll } from "./poll";
import { runQueuePoll } from "./queues";
import { readCatalog, rebuildCatalog } from "./rides";
import type { Env } from "./types";

/** Auxiliary-job cadences (minutes between runs of the SAME item). The only
 *  per-minute work is the park polls themselves (queue feeds every minute; RAP
 *  1m / main 5m availability). Everything else — opening hours, the D1 month-file
 *  and day-file self-heals — is background maintenance that barely needs to be
 *  frequent, so it runs on these long cadences, ONE item per invocation (see
 *  `dueAux`), and never stacks. Hours/events change rarely; the self-heals only
 *  repair drift the per-minute append already keeps current. */
const HOURS_EVERY_MIN = 240; // each park's opening hours: ~every 4h
const REBUILD_EVERY_MIN = 120; // each product's forward month files: ~every 2h
const SELFHEAL_EVERY_MIN = 120; // each park's queue day file: ~every 2h

/**
 * Round-robin scheduler: pick at most ONE item to run this minute so a batch of
 * N background jobs never fires in the same invocation. Item i runs once every
 * `everyMin` minutes (at `epochMinute ≡ i + offset`), so the batch is smeared one
 * item per minute across each cycle. `offset` staggers different schedules so
 * they don't land together. Returns the due index, or -1.
 */
function dueAux(epochMinute: number, count: number, everyMin: number, offset = 0): number {
  const slot = (epochMinute - offset + everyMin) % everyMin;
  return slot < count ? slot : -1;
}

/** Cron schedules (wrangler.toml `triggers.crons`). Each firing is its own
 *  top-level invocation with its OWN free-tier 10ms CPU budget, so the three
 *  independent data streams never share (and blow) one budget — the failure that
 *  froze queues + main tickets when they all ran in a single every-minute cron.
 *  Streams write separate R2 files; the frontend stitches them together.
 *  Cloudflare treats each cron STRING as an independent trigger (`event.cron` is
 *  matched character-for-character), so the two constants below — though both
 *  mean "every minute" — are distinct triggers that BOTH fire every minute as
 *  separate invocations. That's how tickets AND queues each get a 1-minute
 *  cadence in their own budget despite there being only one literal every-minute
 *  spelling. Three crons total = the free-plan per-Worker cap. */
const CRON_TICKETS = "* * * * *"; // RAP (1m) + main (5m); hours/rebuild as low-cadence aux
const CRON_QUEUES = "*/1 * * * *"; // every minute; all parks' ride queue times + low-cadence self-heal
// Pre-open daily maintenance, 08:00–08:07 BST (07:00–07:07 GMT) — before any UK
// park opens (09:00), one job per minute so each CPU-heavy op gets its own fresh
// 10ms budget while parks are closed:
//   minutes 0–3 → rebuild one Attractions.io park's ride catalog (streaming unzip)
//   minutes 4–7 → refresh one accesso ticket park's package discovery (the 2.83MB
//                 bootstrap parse — kept OFF the every-minute ticket poll so it
//                 never blows a daytime budget; conditional-GET makes it near-free
//                 on the common unchanged day).
// Both windows must cover their 4 parks — widen the range if more are added.
const CRON_CATALOG = "0-7 7 * * *";

const currentMonth = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const currentDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Ticket stream (every minute). Each product polls on its own cadence
 *  (RAP 1m / main 5m), derived statelessly from the scheduled time — that's the
 *  only per-minute work. Opening-hours refresh and the forward month-file
 *  self-heal are background maintenance, run one item per invocation on long
 *  cadences (see `dueAux`) so they never stack onto the poll or each other. */
async function pollTickets(env: Env, scheduledTime: number): Promise<void> {
  const epochMinute = Math.floor(scheduledTime / 60_000);
  const jobs: Promise<unknown>[] = dueProducts(epochMinute).map(({ park, product }) =>
    runPoll(env, park, product),
  );
  // Opening hours — one park every ~4h.
  const hoursIdx = dueAux(epochMinute, PARKS.length, HOURS_EVERY_MIN);
  if (hoursIdx >= 0) jobs.push(runHoursPoll(env, PARKS[hoursIdx]));
  // Forward month-file self-heal — one product every ~2h (offset so it doesn't
  // land with the hours refresh). Repairs a product static since deploy.
  const products = allProducts();
  const rebuildIdx = dueAux(epochMinute, products.length, REBUILD_EVERY_MIN, 20);
  if (rebuildIdx >= 0) {
    const { park, product } = products[rebuildIdx];
    jobs.push(
      rebuildMonthsFromD1(
        env.DB,
        env.BUCKET,
        park.key,
        product.key,
        new Date(scheduledTime).toISOString(),
        currentMonth(scheduledTime),
      ),
    );
  }
  await Promise.all(jobs);
}

/** Queue stream (every minute, own invocation/budget). Polls EVERY park's live
 *  feed every minute (conditional GET → an unchanged feed 304s and skips the
 *  work) and appends changed lines. Uses the READ-ONLY cached catalog. The D1
 *  day-file self-heal is background maintenance — one park every ~2h (see
 *  `dueAux`), never all at once — since the per-minute append already keeps each
 *  day file current; this only repairs drift / reseeds a fresh-deploy park. */
async function pollQueues(env: Env, scheduledTime: number): Promise<void> {
  const epochMinute = Math.floor(scheduledTime / 60_000);
  const parks = queueParks();
  const jobs: Promise<unknown>[] = parks.map((park) => runQueuePoll(env, park));
  const healIdx = dueAux(epochMinute, parks.length, SELFHEAL_EVERY_MIN);
  if (healIdx >= 0) {
    const healPark = parks[healIdx];
    const at = new Date(scheduledTime).toISOString();
    const day = currentDay(scheduledTime);
    jobs.push(
      (async () => {
        const catalog = await readCatalog(env.BUCKET, healPark.key);
        await writeQueueDayFile(env.DB, env.BUCKET, healPark.key, day, catalog, at);
        await updateQueueIndex(env.BUCKET, healPark.key, [day], at);
      })(),
    );
  }
  await Promise.all(jobs);
}

/** Pre-open daily maintenance (see CRON_CATALOG), one job per minute so each gets
 *  its own fresh 10ms budget while parks are closed. Minutes 0–3 rebuild one
 *  Attractions.io park's ride catalog (the CPU-heavy content-bundle unzip);
 *  minutes 4–7 refresh one accesso ticket park's package discovery (the 2.83MB
 *  bootstrap parse). Both are kept off every hot path; a failure keeps the last
 *  good cached value. Inline-name parks (Paulton's/Flamingo/Blackpool) have no
 *  bundle and aren't in the 0–3 window; only accesso parks discover packages. */
async function rebuildCatalogs(env: Env, scheduledTime: number): Promise<void> {
  const minute = new Date(scheduledTime).getUTCMinutes();
  if (minute < 4) {
    const park = attractionsParks()[minute];
    if (park) await rebuildCatalog(env.BUCKET, park.key, park.queue, scheduledTime);
    return;
  }
  // Discovery refresh, one discover-product per minute (own budget, separate from
  // the unzips above). Conditional GET → an unchanged catalog 304s (near-free).
  const discovers = allProducts().filter(({ product }) => product.discover);
  const pair = discovers[minute - 4];
  if (pair) await refreshPackages(env.BUCKET, pair.park, pair.product, scheduledTime);
}

export default {
  // Dispatch by which schedule fired — each stream in its own invocation/budget.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    switch (event.cron) {
      case CRON_QUEUES:
        return void ctx.waitUntil(pollQueues(env, event.scheduledTime));
      case CRON_CATALOG:
        return void ctx.waitUntil(rebuildCatalogs(env, event.scheduledTime));
      default: // CRON_TICKETS
        return void ctx.waitUntil(pollTickets(env, event.scheduledTime));
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Precomputed calendar / queue / status JSON from R2 (cached at the edge).
    if (
      url.pathname.startsWith("/calendar/") ||
      url.pathname.startsWith("/queues/") ||
      url.pathname.startsWith("/status/")
    ) {
      const obj = await env.BUCKET.get(url.pathname.slice(1));
      if (!obj) return new Response("not found", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=60",
        },
      });
    }

    // Force a poll of every product now — handy right after deploy. This is a
    // side-effecting endpoint, so gate it behind POLL_KEY (fail closed if the
    // secret isn't configured). Pass ?key=… or an x-poll-key header.
    if (url.pathname === "/poll") {
      const provided = url.searchParams.get("key") ?? req.headers.get("x-poll-key");
      if (!env.POLL_KEY || provided !== env.POLL_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      // Refresh discovery caches first (conditional GET) so the runPoll loop —
      // which now only READS the cache — sees fresh package lists. This is the
      // manual escape hatch for the pre-open daily refresh.
      await Promise.all(
        allProducts()
          .filter(({ product }) => product.discover)
          .map(({ park, product }) => refreshPackages(env.BUCKET, park, product, Date.now())),
      );
      const results = await Promise.all(
        allProducts().map(async ({ park, product }) => ({
          park: park.key,
          product: product.key,
          changed: await runPoll(env, park, product),
        })),
      );
      const hours = await Promise.all(
        PARKS.map(async (park) => ({
          park: park.key,
          product: "hours",
          dates: await runHoursPoll(env, park),
        })),
      );
      const queues = await Promise.all(
        queueParks().map(async (park) => ({
          park: park.key,
          product: "queues",
          changed: await runQueuePoll(env, park),
        })),
      );
      // Full repair: rebuild EVERY month file (past + forward) from D1, so a
      // fresh deploy or a static product immediately gets all its month files.
      const at = new Date().toISOString();
      const rebuilt = await Promise.all(
        allProducts().map(async ({ park, product }) => ({
          park: park.key,
          product: product.key,
          months: (await rebuildMonthsFromD1(env.DB, env.BUCKET, park.key, product.key, at))
            .length,
        })),
      );
      return Response.json({ ok: true, results, hours, queues, rebuilt });
    }

    // Everything else: the static heatmap.
    return env.ASSETS.fetch(req);
  },
};
