# merlin-capacity

Tracks Merlin theme-park ticket availability over time on Cloudflare,
serverless. Runs comfortably in the **free tier**.

Parks and products are pure config in `src/config.ts` (backend) and
`frontend/src/catalog.ts` (nav). Currently: RAP and main tickets for Alton
Towers, Thorpe Park, Legoland Windsor, and Chessington.

Main-ticket package ids rotate seasonally, so they aren't hardcoded — the poller
rediscovers them from accesso's public catalog and caches the result (see
[Autodiscovery](#autodiscovery) and [`docs/accesso-api.md`](docs/accesso-api.md),
which documents the reverse-engineered API). RAP ids are hardcoded because RAP
isn't in the catalog.

- **Poller** — a 1-minute **cron** iterates every park × product, polling each
  on its own cadence (`intervalMinutes`). No Durable Object; cron's 1-min
  granularity is enough.
- **History** — changed days only are appended to **D1** (`observation`), so the
  table is a pure change-log. RAP batch releases show up as `capacity` jumping.
- **Serving** — each poll writes a precomputed `calendar/<park>/<product>.json`
  to **R2**; a React heatmap (`frontend/`, built with Vite → `dist/`) reads it.
  That same file is also the diff baseline for the next poll, so there's no
  separate state store, and RAP and main never race on a shared write. No DB on
  the hot path.

### Autodiscovery

Main-ticket package ids rotate seasonally. Rather than hardcoding them, a `main`
product declares only its stable `event_id` + `customerType` (a `discover` spec
in `src/config.ts`). On poll, the worker derives the package list from the park's
public bootstrap catalog and caches it in R2 (`catalog/<park>/<product>.json`),
refreshing at most twice a day (`DISCOVERY_TTL_MS`) so the 3 MB catalog
fetch/parse stays off the hot path. If the catalog is unreachable or a park is
mid-rotation, the last cached list keeps serving; a product with no list and no
cache logs `NO_PACKAGES` and is skipped. RAP stays hardcoded — it isn't in the
catalog. See [`docs/accesso-api.md`](docs/accesso-api.md).

## What it captures

For `main` and `rap`, per visit date: `capacity`, `available` (tickets left),
`used`. RAP is a hard pool (`available + used == capacity`); main has slack.

## Ride queue times

A second, independent data stream captures **live ride status and queue times**
from the Attractions.io ("Occasio") backend that powers the official park apps
(reverse-engineered in [`docs/attractions-io-api.md`](docs/attractions-io-api.md)).

- **Live feed** — every minute the poller reads each park's unauthenticated live
  feed (`live-data.attractions.io/<apiKey>.json`) and joins it to a static ride
  catalog. Per **queue line** (main, single-rider, …) it records the posted
  wait and status; per ride it records open/operational. Only lines that actually
  moved are appended to D1 (`queue_observation`) — delta-only, like tickets — so
  the table doubles as the intraday open/close + wait-change log.
- **Ride names** come from the park's static content bundle. `src/rides.ts`
  registers an installation once (token cached in R2), resolves the current
  bundle, and **streams the zip** inflating only `records.json` + `manifest.json`
  (never the `media/*` bulk) into an id→name / queue-line→ride catalog, cached in
  R2 with last-good fallback. The unzip is the one CPU-heavy step, so it's rebuilt
  by a **daily pre-open cron** (08:00 BST) rather than inline; the live poll only
  ever reads the cached catalog.
- **Serving** — each changed poll regenerates `queues/<park>/<YYYY-MM-DD>.json`
  from D1 (each queue line's day as compact `[minsSinceUtcMidnight, wait, open]`
  tuples). The frontend's **Queues** tab lists rides with a per-line sparkline
  (shared y-scale, so busy rides read taller); tapping a ride expands a full step
  chart with hourly park-local axis and a hover crosshair + tooltip. Date-nav
  steps back through history (`queues/<park>/index.json` = `{minDate,maxDate}`).

> Note: the three data streams (tickets, queues, catalog) each run on their own
> cron so each gets its own free-tier 10 ms CPU budget — sharing one every-minute
> cron blew that budget and froze the streams. Cadence is set by the `crons` in
> `wrangler.toml`. Queue polling is delta-only (stable waits cost nothing);
> planned next: compare a day's queues against similar days with similar park
> capacity (the D1 log already holds both).

## Layout

- `src/` — the Worker: cron poller (`poll.ts`), API client (`merlin.ts`),
  D1/R2 helpers (`db.ts`), config/IDs (`config.ts`), entry (`index.ts`).
  Queue times: live poll (`queues.ts`) + static ride catalog (`rides.ts`).
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
- Discovery cache lifetime: `DISCOVERY_TTL_MS` in `src/config.ts`.
- Main-ticket ids are rediscovered automatically (see [Autodiscovery](#autodiscovery)).
  RAP ids are hardcoded — refresh them in `src/config.ts` if RAP starts returning
  `status: FAILED` (visible in the `poll_log` table). A main product logging
  `NO_PACKAGES` means the catalog's event/CT filter matched nothing; check the
  park's `bootstrapSlug` and the `discover` spec against `docs/accesso-api.md`.

## Inspecting history

```sh
npx wrangler d1 execute merlin-capacity --remote \
  --command "SELECT event_date, capacity, available, used, observed_at
             FROM observation WHERE product='rap' ORDER BY observed_at DESC LIMIT 20"
```
