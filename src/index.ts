import {
  allProducts,
  attractionsParks,
  dueProducts,
  HOURS_INTERVAL_MINUTES,
  PARKS,
  queueParks,
} from "./config";
import { rebuildMonthsFromD1, updateQueueIndex, writeQueueDayFile } from "./db";
import { refreshPackages } from "./discover";
import { runHoursPoll } from "./hours";
import { runPoll } from "./poll";
import { runQueuePoll } from "./queues";
import { readCatalog, rebuildCatalog } from "./rides";
import type { Env } from "./types";

/** How often the cron re-derives the forward month files from D1, so a product
 *  that's been static since deploy (no deltas → no per-poll rewrite) still gets
 *  its current/future month files. Cheap: only the forward window, from D1. */
const REBUILD_INTERVAL_MINUTES = 30;

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
const CRON_TICKETS = "* * * * *"; // RAP (1m) + main (5m) + hours (60m) + rebuilds (30m)
const CRON_QUEUES = "*/1 * * * *"; // every minute; ride queue times + self-heal (30m)
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
 *  (intervalMinutes), derived statelessly from the scheduled time. Every
 *  REBUILD_INTERVAL_MINUTES it also self-heals the forward month files from D1.
 *  This is the pre-queue workload, restored to its own invocation. */
async function pollTickets(env: Env, scheduledTime: number): Promise<void> {
  const epochMinute = Math.floor(scheduledTime / 60_000);
  const jobs: Promise<unknown>[] = dueProducts(epochMinute).map(({ park, product }) =>
    runPoll(env, park, product),
  );
  // Opening hours change rarely — refresh every HOURS_INTERVAL_MINUTES.
  if (epochMinute % HOURS_INTERVAL_MINUTES === 0) {
    jobs.push(...PARKS.map((park) => runHoursPoll(env, park)));
  }
  // Periodically re-derive the forward month files from D1 (self-heal any
  // product whose data has been static and so got no per-poll rewrite).
  if (epochMinute % REBUILD_INTERVAL_MINUTES === 0) {
    const from = currentMonth(scheduledTime);
    const at = new Date(scheduledTime).toISOString();
    jobs.push(
      ...allProducts().map(({ park, product }) =>
        rebuildMonthsFromD1(env.DB, env.BUCKET, park.key, product.key, at, from),
      ),
    );
  }
  await Promise.all(jobs);
}

/** Queue stream (every minute, own invocation/budget). Reads each park's live
 *  feed and appends changed lines. Uses the READ-ONLY cached catalog — never rebuilds it (that's the
 *  daily cron's job); a missing catalog just degrades to unnamed lines until the
 *  next rebuild. Every REBUILD_INTERVAL_MINUTES it self-heals today's day file
 *  from D1 (covers a fresh deploy or a static-since-open park). */
async function pollQueues(env: Env, scheduledTime: number): Promise<void> {
  const epochMinute = Math.floor(scheduledTime / 60_000);
  const jobs: Promise<unknown>[] = queueParks().map((park) => runQueuePoll(env, park));
  if (epochMinute % REBUILD_INTERVAL_MINUTES === 0) {
    const at = new Date(scheduledTime).toISOString();
    const day = currentDay(scheduledTime);
    jobs.push(
      ...queueParks().map(async (park) => {
        const catalog = await readCatalog(env.BUCKET, park.key);
        await writeQueueDayFile(env.DB, env.BUCKET, park.key, day, catalog, at);
        await updateQueueIndex(env.BUCKET, park.key, [day], at);
      }),
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
