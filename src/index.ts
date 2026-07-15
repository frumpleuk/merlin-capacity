import { runPoll } from "./poll";
import type { Env } from "./types";

export default {
  // One cron a minute — poll both products; each writes its own R2 file / D1 rows.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([runPoll(env, "rap"), runPoll(env, "main")]));
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

    // Force a poll of both products now — handy right after deploy.
    if (url.pathname === "/poll") {
      const rap = await runPoll(env, "rap");
      const main = await runPoll(env, "main");
      return Response.json({ ok: true, rap_changed: rap, main_changed: main });
    }

    // Everything else: the static heatmap.
    return env.ASSETS.fetch(req);
  },
};
