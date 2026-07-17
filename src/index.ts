import { allProducts, dueProducts, HOURS_INTERVAL_MINUTES, PARKS } from "./config";
import { runHoursPoll } from "./hours";
import { runPoll } from "./poll";
import type { Env } from "./types";

export default {
  // One cron a minute. Each product polls on its own cadence (intervalMinutes),
  // derived statelessly from the scheduled time. Each writes its own R2 file.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const epochMinute = Math.floor(event.scheduledTime / 60_000);
    const due = dueProducts(epochMinute);
    const jobs: Promise<unknown>[] = due.map(({ park, product }) =>
      runPoll(env, park, product),
    );
    // Opening hours change rarely — refresh every HOURS_INTERVAL_MINUTES.
    if (epochMinute % HOURS_INTERVAL_MINUTES === 0) {
      jobs.push(...PARKS.map((park) => runHoursPoll(env, park)));
    }
    ctx.waitUntil(Promise.all(jobs));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Precomputed calendar JSON from R2 (cache at the edge in front of this).
    if (url.pathname.startsWith("/calendar/")) {
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
      return Response.json({ ok: true, results, hours });
    }

    // Everything else: the static heatmap.
    return env.ASSETS.fetch(req);
  },
};
