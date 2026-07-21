import { useMemo, useRef, useState } from "react";
import type { QueueDayFile, QueueLineSeries, QueueRide, QueueSample } from "./api";
import { longDate } from "./Heatmap";

/* ── Time helpers ──────────────────────────────────────────────────────────────
 * Samples carry minutes since UTC midnight. Park-local time (Europe/London,
 * BST/GMT year-round) is reconstructed from the day's date + the offset so the
 * axis reads in the times guests actually experience. */

const londonTime = (date: string, mins: number): string =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() + mins * 60_000).toLocaleTimeString(
    "en-GB",
    { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" },
  );

/** A sample's operational flag, defaulting to operational for older 3-tuple
 *  files that predate the field. A line is "running" when open AND operational. */
const isRunning = (s: QueueSample): boolean => s[2] === 1 && (s[3] ?? 1) === 1;

/** The current wait while running, and the day's peak — the row summary. An
 *  open-but-unreported reading holds the last known wait (bridged), so a running
 *  ride reads as its last posted time rather than "Closed". */
function lineStats(line: QueueLineSeries): { current: number | null; peak: number } {
  let current: number | null = null;
  let peak = 0;
  let lastW: number | null = null;
  for (const s of line.samples) {
    const w = s[1];
    if (isRunning(s)) {
      if (w != null) {
        lastW = w;
        if (w > peak) peak = w;
      }
      current = w != null ? w : lastW;
    } else {
      current = null; // closed / not operating now
      lastW = null;
    }
  }
  return { current, peak };
}

const ridePeak = (ride: QueueRide): number =>
  Math.max(0, ...ride.lines.map((l) => lineStats(l).peak));

/** The ride's headline current wait (max across its lines), or null if closed. */
const rideNow = (ride: QueueRide): number | null => {
  const vals = ride.lines
    .map((l) => lineStats(l).current)
    .filter((v): v is number => v != null);
  return vals.length ? Math.max(...vals) : null;
};

export type SortMode = "now" | "peak" | "name";
export type SortDir = "asc" | "desc";

/** The natural default direction for each mode (busiest first; A→Z). */
export const defaultDir = (sort: SortMode): SortDir => (sort === "name" ? "asc" : "desc");

const rideComparator =
  (sort: SortMode, dir: SortDir) => (a: QueueRide, b: QueueRide) => {
    // Closed rides sink to the bottom regardless of direction — except when
    // sorting by Peak, where a since-closed ride's peak is still meaningful.
    if (sort !== "peak") {
      const aClosed = rideNow(a) == null;
      const bClosed = rideNow(b) == null;
      if (aClosed !== bClosed) return aClosed ? 1 : -1;
    }
    let asc: number;
    if (sort === "name") asc = a.name.localeCompare(b.name);
    else {
      const va = sort === "now" ? rideNow(a) ?? -1 : ridePeak(a);
      const vb = sort === "now" ? rideNow(b) ?? -1 : ridePeak(b);
      asc = va - vb;
    }
    const signed = dir === "asc" ? asc : -asc;
    return signed || a.name.localeCompare(b.name);
  };

/* ── Line geometry ─────────────────────────────────────────────────────────────
 * Samples are change-points (a value holds until the next one) → a step line.
 * While the ride is running the line is solid in the ride colour and tracks the
 * posted wait (bridging open-but-unreported blips). While it's closed we don't
 * know the real queue — it may still be full, or it may have been evacuated — so
 * we don't invent or hold a number: the closed stretch is a solid line pinned
 * to the baseline (0) in the closed colour. Running and closed stretches are
 * drawn DISCONNECTED (no vertical drop/rise between them), so a closure reads as
 * "closed here" rather than the queue emptying to zero and refilling. */

/** Where the closed/non-operational line sits: the baseline. */
const CLOSED_WAIT = 0;

type LinePoint = { t: number; w: number; closed: boolean };

/**
 * Drawable points across the day. Running samples map to their wait (bridging
 * open-but-unreported blips to the last known wait). Closed / non-operational
 * samples pin to the baseline and carry `closed` so they render in the closed
 * colour. A ride closed all day is all baseline (so it clearly reads as closed).
 */
function linePoints(samples: QueueSample[]): LinePoint[] {
  const pts: LinePoint[] = [];
  let lastW: number | null = null;
  for (const s of samples) {
    if (isRunning(s)) {
      const v: number | null = s[1] != null ? s[1] : lastW; // bridge open-but-unreported
      if (v == null) continue; // no level yet — nothing to draw
      pts.push({ t: s[0], w: v, closed: false });
      lastW = v;
    } else {
      pts.push({ t: s[0], w: CLOSED_WAIT, closed: true }); // closed → baseline
      lastW = null;
    }
  }
  return pts;
}

/**
 * The step geometry split into a solid path (running) and a dashed path
 * (closed). Step-after: each point's value holds horizontally to the next. A
 * vertical step is drawn only BETWEEN TWO POINTS OF THE SAME STATE (a real wait
 * change while running) — the running↔closed transition is left disconnected,
 * so there's no misleading drop to zero or rise back up. Delta-only storage
 * means the last reading holds until the next poll, so the final value extends
 * to `asOf`. A lone point with nothing to extend to is a dot.
 */
function lineGeometry(
  samples: QueueSample[],
  x: (t: number) => number,
  y: (w: number) => number,
  asOf?: number,
): { d: string; closedD: string; dots: { cx: number; cy: number; closed: boolean }[] } {
  const pts = linePoints(samples);
  if (pts.length === 0) return { d: "", closedD: "", dots: [] };

  const lastT = pts[pts.length - 1].t;
  const endT = asOf != null && asOf > lastT ? asOf : null;

  if (pts.length === 1 && endT == null) {
    const p = pts[0];
    return { d: "", closedD: "", dots: [{ cx: x(p.t), cy: y(p.w), closed: p.closed }] };
  }

  let d = "";
  let closedD = "";
  const add = (closed: boolean, seg: string) => {
    if (closed) closedD += seg;
    else d += seg;
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const xi = x(p.t);
    const yi = y(p.w);
    // Vertical step only between two same-state points (a wait change while
    // running). Skip it across a running↔closed transition — disconnected.
    if (i > 0 && pts[i - 1].closed === p.closed) {
      const yPrev = y(pts[i - 1].w);
      if (yPrev !== yi) add(p.closed, `M${xi.toFixed(1)},${yPrev.toFixed(1)}V${yi.toFixed(1)}`);
    }
    // Horizontal hold to the next point (or asOf for the last), in this style.
    const xNext = i + 1 < pts.length ? x(pts[i + 1].t) : endT != null ? x(endT) : null;
    if (xNext != null && xNext !== xi)
      add(p.closed, `M${xi.toFixed(1)},${yi.toFixed(1)}H${xNext.toFixed(1)}`);
  }
  return { d, closedD, dots: [] };
}

/** Render one line's step path + lone-point dots. Dots are zero-length
 *  round-capped strokes so they stay circular even in a non-uniformly scaled
 *  (sparkline) viewBox. */
function LineMarks({
  samples,
  x,
  y,
  colour,
  closedColour,
  width,
  dotWidth,
  asOf,
}: {
  samples: QueueSample[];
  x: (t: number) => number;
  y: (w: number) => number;
  colour: string;
  closedColour: string;
  width: number;
  dotWidth: number;
  asOf?: number;
}) {
  const { d, closedD, dots } = lineGeometry(samples, x, y, asOf);
  return (
    <>
      {d && (
        <path
          d={d}
          fill="none"
          stroke={colour}
          strokeWidth={width}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
      )}
      {closedD && (
        <path
          d={closedD}
          fill="none"
          stroke={closedColour}
          strokeWidth={width}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
      )}
      {dots.map(({ cx, cy, closed }, j) => (
        <path
          key={j}
          d={`M${cx.toFixed(1)},${cy.toFixed(1)}l0.01 0`}
          stroke={closed ? closedColour : colour}
          strokeWidth={dotWidth}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </>
  );
}

/* ── Sparkline (compact, shared y-scale so busy rides read taller) ─────────────── */

const SPARK_W = 240;
const SPARK_H = 34;

function Sparkline({
  ride,
  domain,
  yMax,
  asOf,
}: {
  ride: QueueRide;
  domain: [number, number];
  yMax: number;
  asOf?: number;
}) {
  const [t0, t1] = domain;
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => ((t - t0) / span) * SPARK_W;
  const pad = 3;
  const y = (w: number) => SPARK_H - pad - (w / Math.max(1, yMax)) * (SPARK_H - 2 * pad);

  const colours = ["var(--q-main)", "var(--q-alt)"];

  return (
    <svg
      className="spark"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <line
        x1="0"
        y1={SPARK_H - pad}
        x2={SPARK_W}
        y2={SPARK_H - pad}
        className="spark-base"
        vectorEffect="non-scaling-stroke"
      />
      {ride.lines.map((line, i) => (
        <LineMarks
          key={line.queueLineId}
          samples={line.samples}
          x={x}
          y={y}
          colour={colours[i % colours.length]}
          closedColour="var(--q-closed)"
          width={2}
          dotWidth={5}
          asOf={asOf}
        />
      ))}
    </svg>
  );
}

/* ── Expanded chart (own y-scale for detail, hover crosshair + tooltip) ────────── */

const CH_W = 720;
const CH_H = 210;
const M = { top: 12, right: 14, bottom: 26, left: 34 };

interface Hover {
  t: number;
  xFrac: number;
  rows: { label: string; colour: string; wait: number | null }[];
}

function RideChart({
  ride,
  domain,
  date,
  asOf,
}: {
  ride: QueueRide;
  domain: [number, number];
  date: string;
  asOf?: number;
}) {
  const [t0, t1] = domain;
  const span = Math.max(1, t1 - t0);
  const yMax = Math.max(10, ridePeak(ride));
  const plotW = CH_W - M.left - M.right;
  const plotH = CH_H - M.top - M.bottom;
  const x = (t: number) => M.left + ((t - t0) / span) * plotW;
  const y = (w: number) => M.top + (1 - w / yMax) * plotH;

  const colours = ["var(--q-main)", "var(--q-alt)"];
  const multi = ride.lines.length > 1;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  // The line only spans real data — from the first sample to the last-polled
  // time (or the last sample). Clamp the hover to that window so the tooltip
  // never reports a time past the most recent reading (the axis runs to close).
  const [hoverMin, hoverMax] = useMemo(() => {
    const ts = ride.lines.flatMap((l) => l.samples.map((s) => s[0]));
    if (ts.length === 0) return [t0, t1];
    const lo = Math.min(...ts);
    const hi = Math.max(...ts);
    return [lo, asOf != null && asOf > hi ? asOf : hi];
  }, [ride, asOf, t0, t1]);

  // Hourly x-ticks across the open window.
  const hourTicks = useMemo(() => {
    const ticks: number[] = [];
    const startH = Math.ceil(t0 / 60);
    for (let h = startH * 60; h <= t1; h += 60) ticks.push(h);
    return ticks;
  }, [t0, t1]);

  const yTicks = useMemo(() => {
    const step = yMax <= 30 ? 10 : yMax <= 60 ? 20 : yMax <= 120 ? 30 : 60;
    const ticks: number[] = [];
    for (let v = 0; v <= yMax; v += step) ticks.push(v);
    return ticks;
  }, [yMax]);

  // Value at time t: the last posted wait while running, bridged through
  // open-but-unreported blips, null when closed / not operating.
  const valueAt = (line: QueueLineSeries, t: number): number | null => {
    let val: number | null = null;
    let lastW: number | null = null;
    for (const s of line.samples) {
      if (s[0] > t) break;
      if (isRunning(s)) {
        if (s[1] != null) lastW = s[1];
        val = s[1] != null ? s[1] : lastW;
      } else {
        val = null;
        lastW = null;
      }
    }
    return val;
  };

  const onMove = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const frac = (clientX - rect.left) / rect.width; // 0..1 across full svg
    const px = frac * CH_W;
    if (px < M.left || px > CH_W - M.right) return setHover(null);
    const raw = t0 + ((px - M.left) / plotW) * span;
    const t = Math.min(Math.max(raw, hoverMin), hoverMax); // never past the last reading
    setHover({
      t,
      xFrac: x(t) / CH_W,
      rows: ride.lines.map((line, i) => ({
        label: line.label,
        colour: colours[i % colours.length],
        wait: valueAt(line, t),
      })),
    });
  };

  return (
    <div className="chart-wrap">
      <svg
        ref={svgRef}
        className="chart"
        viewBox={`0 0 ${CH_W} ${CH_H}`}
        role="img"
        aria-label={`${ride.name} queue time through the day`}
        onMouseMove={(e) => onMove(e.clientX)}
        onMouseLeave={() => setHover(null)}
        onTouchMove={(e) => onMove(e.touches[0].clientX)}
        onTouchStart={(e) => onMove(e.touches[0].clientX)}
      >
        {/* y grid + labels */}
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={M.left}
              y1={y(v)}
              x2={CH_W - M.right}
              y2={y(v)}
              className="chart-grid"
              vectorEffect="non-scaling-stroke"
            />
            <text x={M.left - 6} y={y(v)} className="chart-ylabel" dominantBaseline="middle">
              {v}
            </text>
          </g>
        ))}
        {/* x labels */}
        {hourTicks.map((t) => (
          <text key={t} x={x(t)} y={CH_H - 8} className="chart-xlabel" textAnchor="middle">
            {londonTime(date, t)}
          </text>
        ))}
        {/* crosshair */}
        {hover && (
          <line
            x1={x(hover.t)}
            y1={M.top}
            x2={x(hover.t)}
            y2={CH_H - M.bottom}
            className="chart-cross"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {/* series clipped HORIZONTALLY only (to the opening window); full height
            so lines at the very top (peak) or baseline aren't half-clipped. */}
        <defs>
          <clipPath id={`clip-${ride.id}`}>
            <rect x={M.left} y={0} width={plotW} height={CH_H} />
          </clipPath>
        </defs>
        <g clipPath={`url(#clip-${ride.id})`}>
          {ride.lines.map((line, i) => (
            <LineMarks
              key={line.queueLineId}
              samples={line.samples}
              x={x}
              y={y}
              colour={colours[i % colours.length]}
              closedColour="var(--q-closed)"
              width={2}
              dotWidth={7}
              asOf={asOf}
            />
          ))}
        </g>
      </svg>

      {hover && (
        <div
          className="chart-tip"
          style={{
            left: `${hover.xFrac * 100}%`,
            transform: `translateX(${hover.xFrac > 0.5 ? "-100%" : "0"}) translateX(${hover.xFrac > 0.5 ? "-8px" : "8px"})`,
          }}
        >
          <div className="chart-tip-time">{londonTime(date, Math.round(hover.t))}</div>
          {hover.rows.map((r) => (
            <div key={r.label} className="chart-tip-row">
              <span
                className="chart-tip-swatch"
                style={{ background: r.wait == null ? "var(--q-closed)" : r.colour }}
              />
              {multi && <span className="chart-tip-label">{r.label}</span>}
              <strong>{r.wait == null ? "Closed" : `${r.wait} min`}</strong>
            </div>
          ))}
        </div>
      )}

      {multi && (
        <div className="chart-legend">
          {ride.lines.map((line, i) => (
            <span key={line.queueLineId} className="chart-legend-item">
              <span
                className="chart-legend-swatch"
                style={{ background: colours[i % colours.length] }}
              />
              {line.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Ride row (summary + expand) ───────────────────────────────────────────────── */

function RideRow({
  ride,
  domain,
  yMax,
  date,
  asOf,
  open,
  onToggle,
}: {
  ride: QueueRide;
  domain: [number, number];
  yMax: number;
  date: string;
  asOf?: number;
  open: boolean;
  onToggle: () => void;
}) {
  const main = ride.lines[0];
  const stats = main ? lineStats(main) : { current: null, peak: 0 };
  const peak = ridePeak(ride);
  // Never ran today → "Closed all day". "Ran today" = any running sample, OR any
  // sample that carries a posted wait even though currently closed (Paulton's
  // feed keeps a ride's last-known wait after it shuts — a closed row with a
  // reading still means it operated today; Attractions.io nulls the wait when
  // closed, so its closed-all-day rides — seeded with empty samples — are
  // unaffected).
  const ranToday = ride.lines.some((l) =>
    l.samples.some((s) => isRunning(s) || s[1] != null),
  );

  return (
    <div className={"q-row" + (open ? " open" : "")}>
      <button className="q-row-head" onClick={onToggle} aria-expanded={open}>
        <span className="q-name">{ride.name}</span>
        <Sparkline ride={ride} domain={domain} yMax={yMax} asOf={asOf} />
        <span className="q-now">
          {stats.current != null ? (
            <>
              <strong className="q-now-num">{stats.current}</strong>
              <span className="q-unit">min</span>
            </>
          ) : (
            <span className="q-closed">{ranToday ? "Closed" : "Closed all day"}</span>
          )}
        </span>
        <span className="q-peak">{peak > 0 ? `peak ${peak}` : "—"}</span>
      </button>
      {open && <RideChart ride={ride} domain={domain} date={date} asOf={asOf} />}
    </div>
  );
}

/* ── Date navigation ───────────────────────────────────────────────────────────── */

export function DateNav({
  date,
  onPrev,
  onNext,
  canPrev,
  canNext,
}: {
  date: string;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
}) {
  return (
    <div className="rc-nav">
      <button className="rc-nav-btn" onClick={onPrev} disabled={!canPrev} aria-label="Previous day">
        ‹
      </button>
      <h2 className="rc-nav-label">{longDate(date)}</h2>
      <button className="rc-nav-btn" onClick={onNext} disabled={!canNext} aria-label="Next day">
        ›
      </button>
    </div>
  );
}

/* ── Grouping ──────────────────────────────────────────────────────────────────
 * Rides carry the park's own group. For most parks that's a thrill class
 * ("Thrills", "Top Thrills", "Brave Adventurers", …) and we order the sections
 * thrill-first regardless of the park's own order (Chessington lists kids' rides
 * first; we don't). Legoland instead groups by themed land ("LEGO® City",
 * "Kingdom of the Pharaohs", …) — those aren't a ranking, so `file.groupBy ===
 * "land"` orders them alphabetically with one calm, uniform tone (the land name
 * is the identity, not the colour). Unidentified rides (parent absent from the
 * content bundle) get their own section, always last; rides the bundle names but
 * doesn't place fall to a trailing "Other". */

function groupRank(group: string | undefined, unidentified: boolean): number {
  if (unidentified) return 1000;
  if (!group) return 900; // named but ungrouped → trailing "Other", before Unidentified
  const n = group.toLowerCase();
  if (/fright|scare|festival|event|christmas|halloween|mardi|winter|easter/.test(n))
    return 400; // seasonal / event overlays
  if (/top thrill|brave|intense|extreme|\bbig\b/.test(n)) return 10;
  if (/family/.test(n)) return 40;
  if (/thrill/.test(n)) return 20;
  if (/mini|little|ranger|junior|kid|toddler|navigate|relax|gentle|young/.test(n))
    return 60;
  return 50;
}

/** A colour tone per group tier — a redundant accent beside the always-present
 *  text label (identity never rests on colour alone). */
function sectionTone(rank: number): string {
  if (rank >= 1000) return "unknown";
  if (rank >= 500) return "other";
  if (rank >= 400) return "seasonal";
  if (rank >= 60) return "gentle";
  if (rank >= 40) return "family";
  return "thrill"; // 10–20
}

interface Section {
  key: string;
  title: string;
  rank: number;
  tone: string;
  rides: QueueRide[];
}

/** A section's rank (sort order) and tone (accent), given the park's grouping
 *  kind. Thrill parks rank thrill-first; land parks tie all lands so they sort
 *  alphabetically under one neutral "land" tone. Both send ungrouped rides to a
 *  trailing "Other" and unidentified rides last. */
function sectionMeta(
  group: string | undefined,
  unidentified: boolean,
  byLand: boolean,
): { rank: number; tone: string } {
  if (unidentified) return { rank: 1000, tone: "unknown" };
  if (!group) return { rank: 900, tone: "other" };
  if (byLand) return { rank: 100, tone: "land" };
  const rank = groupRank(group, unidentified);
  return { rank, tone: sectionTone(rank) };
}

function sectionsOf(
  rides: QueueRide[],
  sort: SortMode,
  dir: SortDir,
  byLand: boolean,
): Section[] {
  const map = new Map<string, Section>();
  for (const ride of rides) {
    const unidentified = ride.named === false;
    const key = unidentified ? "__unidentified" : ride.group ?? "__other";
    const title = unidentified ? "Unidentified" : ride.group ?? "Other";
    let sec = map.get(key);
    if (!sec)
      map.set(
        key,
        (sec = { key, title, ...sectionMeta(ride.group, unidentified, byLand), rides: [] }),
      );
    sec.rides.push(ride);
  }
  const secs = [...map.values()];
  const cmp = rideComparator(sort, dir);
  for (const s of secs) s.rides.sort(cmp);
  return secs.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));
}

/* ── The list ──────────────────────────────────────────────────────────────────── */

/** Buffer (minutes) added either side of the park's opening window, since rides
 *  can open early or the park can run over. */
const OPEN_BUFFER = 30;

const SORTS: { key: SortMode; label: string }[] = [
  { key: "now", label: "Now" },
  { key: "peak", label: "Peak" },
  { key: "name", label: "A–Z" },
];

export function QueueList({
  file,
  date,
  loading,
  asOf,
}: {
  file: QueueDayFile | null;
  date: string;
  loading: boolean;
  asOf?: number;
}) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [sort, setSort] = useState<SortMode>("now");
  const [dir, setDir] = useState<SortDir>("desc");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const sections = useMemo(
    () => sectionsOf(file?.rides ?? [], sort, dir, file?.groupBy === "land"),
    [file, sort, dir],
  );

  // Click a sort: switch to it (its natural direction), or flip if already active.
  const onSort = (key: SortMode) => {
    if (key === sort) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(defaultDir(key));
    }
  };

  // Shared x-domain (the park's opening window ± a buffer, so the axis is the
  // day's operating hours rather than just the span of captured data) and a
  // shared y-scale across ALL rides, so sparklines are comparable.
  const { domain, yMax } = useMemo(() => {
    const rs = file?.rides ?? [];
    let lo = Infinity;
    let hi = -Infinity;
    let max = 0;
    for (const r of rs) {
      for (const l of r.lines) {
        for (const [t, w, open] of l.samples) {
          if (open === 1 && w != null) {
            if (t < lo) lo = t;
            if (t > hi) hi = t;
            if (w > max) max = w;
          }
        }
      }
    }
    const dom: [number, number] =
      file?.open != null && file.close != null
        ? [file.open - OPEN_BUFFER, file.close + OPEN_BUFFER]
        : lo < hi
          ? [lo, hi]
          : [9 * 60, 18 * 60];
    return { domain: dom, yMax: Math.max(10, max) };
  }, [file]);

  if (loading) return <p className="empty">Loading…</p>;
  if (!file || sections.length === 0)
    return <p className="empty">No queue data for {longDate(date)} yet.</p>;

  const anyOpen = sections.some((s) => s.rides.some((r) => rideNow(r) != null));
  const toggleSection = (key: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  return (
    <div className="q-list">
      <div className="q-toolbar">
        <div className="q-sort" role="group" aria-label="Sort rides">
          <span className="q-sort-label">Sort</span>
          {SORTS.map((s) => (
            <button
              key={s.key}
              className={"q-sort-btn" + (sort === s.key ? " active" : "")}
              onClick={() => onSort(s.key)}
              aria-pressed={sort === s.key}
              title={sort === s.key ? "Click to reverse" : undefined}
            >
              {s.label}
              {sort === s.key && <span className="q-sort-arrow">{dir === "asc" ? "▲" : "▼"}</span>}
            </button>
          ))}
        </div>
      </div>
      {!anyOpen && (
        <p className="q-hint">
          All rides closed for this day — tap a ride to see its recorded history.
        </p>
      )}
      <div className="q-head-row">
        <span className="q-name">Ride</span>
        <span className="q-spark-col">Today</span>
        <span className="q-now">Now</span>
        <span className="q-peak">Peak</span>
      </div>
      {sections.map((sec) => {
        const isCollapsed = collapsed.has(sec.key);
        return (
          <section key={sec.key} className="q-section" data-tone={sec.tone}>
            <button
              className="q-section-head"
              onClick={() => toggleSection(sec.key)}
              aria-expanded={!isCollapsed}
            >
              <span
                className={"q-section-chevron" + (isCollapsed ? " collapsed" : "")}
                aria-hidden="true"
              />
              <span className="q-section-dot" aria-hidden="true" />
              <span className="q-section-title">
                {sec.title} ({sec.rides.length})
              </span>
              {sec.key === "__unidentified" && (
                <span className="q-section-note">not yet in the park’s ride list</span>
              )}
            </button>
            {!isCollapsed && (
              <div className="q-section-body">
                {sec.rides.map((ride) => (
                  <RideRow
                    key={ride.id}
                    ride={ride}
                    domain={domain}
                    yMax={yMax}
                    date={date}
                    asOf={asOf}
                    open={openId === ride.id}
                    onToggle={() => setOpenId((cur) => (cur === ride.id ? null : ride.id))}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
