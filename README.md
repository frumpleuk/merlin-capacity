# merlin-capacity

Tracks Alton Towers ticket availability over time on Cloudflare, serverless.
Runs comfortably in the **free tier**.

- **Poller** — a 1-minute **cron** polls the accesso availability API for both
  products (RAP + main tickets). No Durable Object; cron's 1-min granularity is
  enough.
- **History** — changed days only are appended to **D1** (`observation`), so the
  table is a pure change-log. RAP batch releases show up as `capacity` jumping.
- **Serving** — each poll writes a precomputed `calendar/<park>/<product>.json`
  to **R2**; a React heatmap (`frontend/`, built with Vite → `dist/`) reads it.
  That same file is also the diff baseline for the next poll, so there's no
  separate state store, and RAP and main never race on a shared write. No DB on
  the hot path.

## What it captures

For `main` and `rap`, per visit date: `capacity`, `available` (tickets left),
`used`. RAP is a hard pool (`available + used == capacity`); main has slack.

## Layout

- `src/` — the Worker: cron poller (`poll.ts`), API client (`merlin.ts`),
  D1/R2 helpers (`db.ts`), config/IDs (`config.ts`), entry (`index.ts`).
- `frontend/` — Vite + React heatmap; builds to `dist/`, served as Workers Assets.
- `migrations/` — D1 schema.

## Local development

```sh
npm install

# One time: create the local D1 tables
npm run db:migrate:local
```

The manual `/poll` trigger is gated by a secret. For local dev, provide it via
`.dev.vars` (wrangler loads it automatically):

```sh
cp .dev.vars.example .dev.vars   # POLL_KEY=localdev
```

Two ways to run locally (no Cloudflare login needed — D1/R2 are simulated):

```sh
# A) UI iteration with hot reload:
npm run dev:api      # terminal 1: Worker + simulated D1/R2 on :8787
npm run dev:web      # terminal 2: Vite dev server (HMR), proxies data to :8787
curl "localhost:8787/poll?key=localdev"   # populate data (cron doesn't fire locally)
# open the Vite URL it prints (e.g. http://localhost:5173)

# B) Whole thing as it deploys (built assets + Worker together):
npm run preview      # builds, then wrangler dev
curl "localhost:8787/poll?key=localdev"
# open http://localhost:8787
```

## One-time setup

```sh
npm install
npx wrangler login

# Create resources, then paste the printed database_id into wrangler.toml
npx wrangler d1 create merlin-capacity
npx wrangler r2 bucket create merlin-capacity

# Create tables (remote)
npm run db:migrate

# Set the secret that gates the manual /poll trigger
npx wrangler secret put POLL_KEY
```

## Deploy (manual)

`npm run deploy` builds the frontend and runs `wrangler deploy`. The cron then
runs within a minute; force a first poll immediately if you don't want to wait
(the `/poll` trigger requires the `POLL_KEY` secret set above):

```sh
npm run deploy
curl "https://merlin-capacity.<your-subdomain>.workers.dev/poll?key=<POLL_KEY>"
```

Then open the Worker URL for the heatmap.

## Continuous deployment (Cloudflare Workers Builds)

No GitHub Actions needed — use Cloudflare's native Git integration. In the
dashboard: **Workers & Pages → merlin-capacity → Settings → Build → Connect**,
pick the repo, and set:

- **Build command:** `npm ci && npm run build`
- **Deploy command:** `npx wrangler d1 migrations apply merlin-capacity --remote && npx wrangler deploy`

Every push to the production branch then builds and deploys automatically, and
applies any new D1 migrations first (the deploy command handles that — Workers
Builds won't run migrations on its own). No API-token secret to manage.

> The one-time resource creation below still has to be done by hand once, before
> the first auto-deploy — CI deploys *to* the D1 database and R2 bucket, it
> doesn't create them.

## Tuning

- Poll cadence: the `crons` list in `wrangler.toml`. `* * * * *` is every minute;
  use `*/2 * * * *` to halve the write volume if you ever approach D1's
  100k-writes/day free limit.
- Horizon: `HORIZON_DAYS` in `src/config.ts`.
- Package/event IDs go stale over time — refresh them in `src/config.ts` when a
  product starts returning `status: FAILED` (visible in the `poll_log` table).

## Inspecting history

```sh
npx wrangler d1 execute merlin-capacity --remote \
  --command "SELECT event_date, capacity, available, used, observed_at
             FROM observation WHERE product='rap' ORDER BY observed_at DESC LIMIT 20"
```
