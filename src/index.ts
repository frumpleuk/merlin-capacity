import {
  allProducts,
  dueProducts,
  HOURS_INTERVAL_MINUTES,
  PARKS,
  QUEUE_INTERVAL_MINUTES,
  queueParks,
} from "./config";
import { rebuildMonthsFromD1, updateQueueIndex, writeQueueDayFile } from "./db";
import { runHoursPoll } from "./hours";
import { runPoll } from "./poll";
import { runQueuePoll } from "./queues";
import { resolveRideCatalog } from "./rides";
import type { Env } from "./types";

/** How often the cron re-derives the forward month files from D1, so a product
 *  that's been static since deploy (no deltas → no per-poll rewrite) still gets
 *  its current/future month files. Cheap: only the forward window, from D1. */
const REBUILD_INTERVAL_MINUTES = 30;

const currentMonth = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const currentDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export default {
  // One cron a minute. Each product polls on its own cadence (intervalMinutes),
  // derived statelessly from the scheduled time. Each writes its own R2 file.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const epochMinute = Math.floor(event.scheduledTime / 60_000);
    const due = dueProducts(epochMinute);
    const jobs: Promise<unknown>[] = due.map(({ park, product }) =>
      runPoll(env, park, product),
    );
    // Ride queue times — poll the live feed on its own cadence (every minute).
    if (epochMinute % QUEUE_INTERVAL_MINUTES === 0) {
      jobs.push(...queueParks().map((park) => runQueuePoll(env, park)));
    }
    // Opening hours change rarely — refresh every HOURS_INTERVAL_MINUTES.
    if (epochMinute % HOURS_INTERVAL_MINUTES === 0) {
      jobs.push(...PARKS.map((park) => runHoursPoll(env, park)));
    }
    // Periodically re-derive the forward month files from D1 (self-heal any
    // product whose data has been static and so got no per-poll rewrite).
    if (epochMinute % REBUILD_INTERVAL_MINUTES === 0) {
      const from = currentMonth(event.scheduledTime);
      const at = new Date(event.scheduledTime).toISOString();
      jobs.push(
        ...allProducts().map(({ park, product }) =>
          rebuildMonthsFromD1(env.DB, env.BUCKET, park.key, product.key, at, from),
        ),
      );
      // Self-heal today's queue day file from D1 (covers a fresh deploy or a
      // static-since-open park that got no per-poll rewrite). Today only.
      const day = currentDay(event.scheduledTime);
      jobs.push(
        ...queueParks().map(async (park) => {
          const catalog = await resolveRideCatalog(
            env.BUCKET,
            park.key,
            park.attractions,
            event.scheduledTime,
          );
          await writeQueueDayFile(env.DB, env.BUCKET, park.key, day, catalog, at);
          await updateQueueIndex(env.BUCKET, park.key, [day], at);
        }),
      );
    }
    ctx.waitUntil(Promise.all(jobs));
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
