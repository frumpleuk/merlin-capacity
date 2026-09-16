import { refreshAnomalies } from "./anomalies";
import { archiveQueues } from "./archive";
import { allProducts, attractionsParks, fosParks, PARKS, queueParks } from "./config";
import { rebuildMonthsFromD1 } from "./db";
import { refreshPackages } from "./discover";
import { runHoursPoll } from "./hours";
import { refreshPaultonsRestrictions } from "./paultons-restrictions";
import { runPoll } from "./poll";
import { runQueuePoll } from "./queues";
import { refreshRestrictions } from "./restrictions";
import { rebuildCatalog } from "./rides";
import { refreshSpecialDays } from "./special-days";
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
const CRON_SPECIAL = "5 7 * * *"; // 07:05 GMT: name the buyout / ticketed-event days
const CRON_ARCHIVE = "0 4 * * *"; // 04:00 GMT: cold queue days out of D1, into R2

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
 *  but hourly surfaces a new month or special event promptly. The Merlin Annual
 *  Pass restriction calendar rides along: same kind of source (a marketing-site
 *  JSON calendar), same rate of change, and two more GETs an hour. */
async function pollHours(env: Env, scheduledTime: number): Promise<void> {
  await Promise.all([
    ...PARKS.map((park) => runHoursPoll(env, park)),
    refreshRestrictions(env, scheduledTime),
  ]);
}

/** Self-heal the forward month files from D1 for every ticket product — repairs a
 *  product static since deploy (no deltas → no per-poll rewrite). The queue day
 *  files need no equivalent: they're re-projected from D1 on every changed poll. */
async function pollRebuild(env: Env, scheduledTime: number): Promise<void> {
  const at = new Date(scheduledTime).toISOString();
  const from = currentMonth(scheduledTime);
  await Promise.all(
    allProducts().map(({ park, product }) =>
      rebuildMonthsFromD1(env.DB, env.BUCKET, park.key, product.key, at, from, product.label),
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

/** Name the dates the park operates but doesn't sell to the public — private
 *  buyouts and separately-ticketed events (see special-days.ts). Runs five
 *  minutes after the pre-open cron so it reads a freshly refreshed package
 *  cache, and costs one request per exclusive package (a few dozen per park). */
async function pollSpecialDays(env: Env, scheduledTime: number): Promise<void> {
  await Promise.all(
    allProducts()
      .filter(({ product }) => product.discover)
      .map(({ park, product }) => refreshSpecialDays(env, park, product, scheduledTime)),
  );
  // Strictly after, so the days just explained are excluded from the report.
  await Promise.all(PARKS.map((park) => refreshAnomalies(env, park, scheduledTime)));
}

/** Move queue days past the retention window out of D1 and into R2 (archive.ts).
 *  04:00 GMT: every park is shut, nothing is polling hard, and yesterday has been
 *  closed out for hours. Each park is independent — one park failing verification
 *  stops that park for tonight and leaves its rows in D1, which is the safe way
 *  round, and the others still drain. */
async function runArchive(env: Env, scheduledTime: number): Promise<void> {
  await Promise.all(
    queueParks().map(async (park) => {
      try {
        await archiveQueues(env.DB, env.BUCKET, park.key, scheduledTime);
      } catch (err) {
        console.error(`archive failed for ${park.key}:`, err);
      }
    }),
  );
}

export default {
  // Dispatch by which schedule fired — each concern in its own invocation.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    switch (event.cron) {
      case CRON_TICKETS:
        return void ctx.waitUntil(pollTickets(env));
      case CRON_HOURS:
        return void ctx.waitUntil(pollHours(env, event.scheduledTime));
      case CRON_REBUILD:
        return void ctx.waitUntil(pollRebuild(env, event.scheduledTime));
      case CRON_PREOPEN:
        return void ctx.waitUntil(preOpen(env, event.scheduledTime));
      case CRON_SPECIAL:
        return void ctx.waitUntil(pollSpecialDays(env, event.scheduledTime));
      case CRON_ARCHIVE:
        return void ctx.waitUntil(runArchive(env, event.scheduledTime));
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

    // Subscribable iCal feeds (see ical.ts). Regenerated by the hours poll, so
    // they're served straight from R2 like the JSON — with the media type that
    // makes a calendar client take them, and a longer cache: a client that
    // refetches hourly shouldn't reach the origin every time.
    if (url.pathname.startsWith("/ical/") && url.pathname.endsWith(".ics")) {
      const obj = await env.BUCKET.get(url.pathname.slice(1));
      if (!obj) return new Response("not found", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "content-type": "text/calendar; charset=utf-8",
          "content-disposition": `inline; filename="${url.pathname.split("/").pop()}"`,
          "cache-control": "public, max-age=900",
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
      // Estate-wide, not per park — one fetch for every Merlin park's calendar.
      const restrictions = await refreshRestrictions(env, Date.now());
      const queues = await Promise.all(
        queueParks().map(async (park) => ({
          park: park.key,
          product: "queues",
          changed: await runQueuePoll(env, park),
        })),
      );
      // Special days last: it reads the package cache refreshed above AND the
      // main product snapshot the poll above just rewrote.
      const special = await Promise.all(
        allProducts()
          .filter(({ product }) => product.discover)
          .map(async ({ park, product }) => ({
            park: park.key,
            product: "special",
            dates: await refreshSpecialDays(env, park, product, Date.now()),
          })),
      );
      const anomalies = await Promise.all(
        PARKS.filter((park) => park.products.length > 0).map(async (park) => ({
          park: park.key,
          product: "anomalies",
          dates: await refreshAnomalies(env, park, Date.now()),
        })),
      );
      // Full repair: rebuild EVERY month file (past + forward) from D1, so a
      // fresh deploy or a static product immediately gets all its month files.
      const at = new Date().toISOString();
      const rebuilt = await Promise.all(
        allProducts().map(async ({ park, product }) => ({
          park: park.key,
          product: product.key,
          months: (
            await rebuildMonthsFromD1(
              env.DB,
              env.BUCKET,
              park.key,
              product.key,
              at,
              undefined,
              product.label,
            )
          ).length,
        })),
      );
      return Response.json({
        ok: true,
        results,
        hours,
        restrictions,
        queues,
        special,
        anomalies,
        rebuilt,
      });
    }

    // Drain the archive backlog on demand, rather than waiting for the nightly
    // cron to take MAX_QUEUE_DAYS_PER_RUN days a night. Same gate as /poll: this
    // deletes from D1 (only ever after the rows are readable back out of R2), so
    // it fails closed when POLL_KEY isn't configured.
    if (url.pathname === "/archive") {
      const provided = url.searchParams.get("key") ?? req.headers.get("x-poll-key");
      if (!env.POLL_KEY || provided !== env.POLL_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const now = Date.now();
      const queues = await Promise.all(
        queueParks().map(async (park) => {
          try {
            return { park: park.key, ...(await archiveQueues(env.DB, env.BUCKET, park.key, now)) };
          } catch (err) {
            return { park: park.key, days: [], rows: 0, error: String(err) };
          }
        }),
      );
      return Response.json({ ok: true, queues });
    }

    // Everything else: the static heatmap.
    return env.ASSETS.fetch(req);
  },
};
