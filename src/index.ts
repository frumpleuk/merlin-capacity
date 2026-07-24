import { allProducts, attractionsParks, fosParks, PARKS, queueParks } from "./config";
import { rebuildMonthsFromD1 } from "./db";
import { refreshPackages } from "./discover";
import { runHoursPoll } from "./hours";
import { refreshPaultonsRestrictions } from "./paultons-restrictions";
import { runPoll } from "./poll";
import { runQueuePoll } from "./queues";
import { rebuildCatalog } from "./rides";
import type { Env } from "./types";

/**
 * Cron schedules (wrangler.toml `triggers.crons`), one per concern. Each firing is
 * its own invocation; on the paid plan that's 30s of CPU, so there's no need to
 * split budgets or smear work — every job just processes all its parks/products in
 * one pass. Cloudflare matches `event.cron` by exact string and a cron list
 * de-dupes identical strings, so the two every-minute streams (queues, tickets)
 * use two different valid spellings of "every minute" (see the constants below) to
 * register as two independent triggers → two isolated invocations (a slow queue
 * poll never delays tickets).
 */
const CRON_QUEUES = "* * * * *"; // live ride queue times — all parks, every minute
const CRON_TICKETS = "*/1 * * * *"; // accesso availability (RAP + main) — all products, every minute
const CRON_HOURS = "0 * * * *"; // opening-hours calendars — all parks, hourly
const CRON_REBUILD = "*/30 * * * *"; // self-heal the ticket month files from D1
const CRON_PREOPEN = "0 7 * * *"; // 07:00 GMT (parks shut): catalog rebuild + discovery

const currentMonth = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/** Live ride queue times — every park, every minute. A conditional GET means an
 *  unchanged feed 304s and skips the work; a changed feed appends its deltas to D1
 *  and re-projects the served day file from that log (see runQueuePoll). */
async function pollQueues(env: Env): Promise<void> {
  await Promise.all(queueParks().map((park) => runQueuePoll(env, park)));
}

/** accesso ticket availability — RAP and main, every product, every minute
 *  (diff-on-write, so a poll only writes when a date's numbers actually moved). */
async function pollTickets(env: Env): Promise<void> {
  await Promise.all(allProducts().map(({ park, product }) => runPoll(env, park, product)));
}

/** Opening-hours calendars — every park, hourly. Cheap GETs; hours change rarely
 *  but hourly surfaces a new month or special event promptly. */
async function pollHours(env: Env): Promise<void> {
  await Promise.all(PARKS.map((park) => runHoursPoll(env, park)));
}

/** Self-heal the forward month files from D1 for every ticket product — repairs a
 *  product static since deploy (no deltas → no per-poll rewrite). The queue day
 *  files need no equivalent: they're re-projected from D1 on every changed poll. */
async function pollRebuild(env: Env, scheduledTime: number): Promise<void> {
  const at = new Date(scheduledTime).toISOString();
  const from = currentMonth(scheduledTime);
  await Promise.all(
    allProducts().map(({ park, product }) =>
      rebuildMonthsFromD1(env.DB, env.BUCKET, park.key, product.key, at, from),
    ),
  );
}

/** Daily pre-open maintenance (07:00 GMT, before any UK park opens): rebuild every
 *  Attractions.io ride catalog (the content-bundle unzip) and refresh every accesso
 *  park's package discovery (the bootstrap parse). Both are kept off the hot path
 *  and keep their last good cached value on failure. */
async function preOpen(env: Env, scheduledTime: number): Promise<void> {
  await Promise.all([
    ...attractionsParks().map((park) =>
      rebuildCatalog(env.BUCKET, park.key, park.queue, scheduledTime),
    ),
    ...allProducts()
      .filter(({ product }) => product.discover)
      .map(({ park, product }) => refreshPackages(env.BUCKET, park, product, scheduledTime)),
    // Paulton's rider restrictions — scraped from the park website (its feed has
    // none), cached in R2 for the every-minute poll to fold onto the catalog.
    ...fosParks().map((park) => refreshPaultonsRestrictions(env.BUCKET, park.key, park.queue)),
  ]);
}

export default {
  // Dispatch by which schedule fired — each concern in its own invocation.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    switch (event.cron) {
      case CRON_TICKETS:
        return void ctx.waitUntil(pollTickets(env));
      case CRON_HOURS:
        return void ctx.waitUntil(pollHours(env));
      case CRON_REBUILD:
        return void ctx.waitUntil(pollRebuild(env, event.scheduledTime));
      case CRON_PREOPEN:
        return void ctx.waitUntil(preOpen(env, event.scheduledTime));
      default: // CRON_QUEUES
        return void ctx.waitUntil(pollQueues(env));
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
      // Refresh discovery caches AND Paulton's restrictions first, so the poll
      // loops below (which only READ these caches) see fresh data. This is the
      // manual escape hatch for the daily pre-open refresh.
      await Promise.all([
        ...allProducts()
          .filter(({ product }) => product.discover)
          .map(({ park, product }) => refreshPackages(env.BUCKET, park, product, Date.now())),
        ...fosParks().map((park) =>
          refreshPaultonsRestrictions(env.BUCKET, park.key, park.queue),
        ),
      ]);
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
