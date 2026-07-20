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

/** The last reported wait while open, and the day's peak — the row summary. */
function lineStats(line: QueueLineSeries): { current: number | null; peak: number } {
  let current: number | null = null;
  let peak = 0;
  for (const [, w, open] of line.samples) {
    if (open === 1 && w != null) {
      current = w;
      if (w > peak) peak = w;
    } else {
      current = null; // closed now
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

const rideComparator = (sort: SortMode) => (a: QueueRide, b: QueueRide) => {
  if (sort === "name") return a.name.localeCompare(b.name);
  const va = sort === "now" ? rideNow(a) ?? -1 : ridePeak(a);
  const vb = sort === "now" ? rideNow(b) ?? -1 : ridePeak(b);
  return vb - va || a.name.localeCompare(b.name);
};

/* ── Line geometry ─────────────────────────────────────────────────────────────
 * Samples are change-points (a value holds until the next one), so the truthful
 * shape is a step line. Closed / not-reporting stretches break the line into
 * separate open runs. A run with a single point is drawn as a dot; a run with
 * two or more points is drawn as a step line between them (no trailing hold —
 * the line ends at the last known reading). */

/** Split a line's samples into runs of consecutive open, reporting points. */
function openRuns(samples: QueueSample[]): [number, number][][] {
  const runs: [number, number][][] = [];
  let cur: [number, number][] | null = null;
  for (const [t, w, open] of samples) {
    if (open === 1 && w != null) {
      if (!cur) runs.push((cur = []));
      cur.push([t, w]);
    } else {
      cur = null;
    }
  }
  return runs;
}

/**
 * Step-line path 'd' plus the dot centres for lone points. A run of ≥2 points
 * is a step line; a lone point is a dot. Delta-only storage means the last
 * reading stays valid until the next poll, so if the ride is still open its
 * final run is held horizontally out to `asOf` (the last-polled time) — that
 * keeps every live sparkline continuous to "now", and turns a still-current lone
 * reading into a line rather than a dot.
 */
function lineGeometry(
  samples: QueueSample[],
  x: (t: number) => number,
  y: (w: number) => number,
  asOf?: number,
): { d: string; dots: [number, number][] } {
  const runs = openRuns(samples);
  const last = samples[samples.length - 1];
  const currentlyOpen = !!last && last[2] === 1 && last[1] != null;

  let d = "";
  const dots: [number, number][] = [];
  runs.forEach((pts, ri) => {
    const isLast = ri === runs.length - 1;
    const extend =
      isLast && currentlyOpen && asOf != null && asOf > pts[pts.length - 1][0];
    if (pts.length === 1 && !extend) {
      dots.push([x(pts[0][0]), y(pts[0][1])]);
      return;
    }
    pts.forEach(([t, w], i) => {
      // Step-after: hold the previous wait horizontally to t, then step to w.
      d +=
        i === 0
          ? `M${x(t).toFixed(1)},${y(w).toFixed(1)}`
          : `H${x(t).toFixed(1)}V${y(w).toFixed(1)}`;
    });
    if (extend) d += `H${x(asOf).toFixed(1)}`; // hold last value out to now
  });
  return { d, dots };
}

/** Render one line's step path + lone-point dots. Dots are zero-length
 *  round-capped strokes so they stay circular even in a non-uniformly scaled
 *  (sparkline) viewBox. */
function LineMarks({
  samples,
  x,
  y,
  colour,
  width,
  dotWidth,
  asOf,
}: {
  samples: QueueSample[];
  x: (t: number) => number;
  y: (w: number) => number;
  colour: string;
  width: number;
  dotWidth: number;
  asOf?: number;
}) {
  const { d, dots } = lineGeometry(samples, x, y, asOf);
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
      {dots.map(([cx, cy], j) => (
        <path
          key={j}
          d={`M${cx.toFixed(1)},${cy.toFixed(1)}l0.01 0`}
          stroke={colour}
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

  // Nearest sample per line at time t (value held from the last change-point).
  const valueAt = (line: QueueLineSeries, t: number): number | null => {
    let val: number | null = null;
    for (const [st, w, open] of line.samples) {
      if (st > t) break;
      val = open === 1 ? w : null;
    }
    return val;
  };

  const onMove = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const frac = (clientX - rect.left) / rect.width; // 0..1 across full svg
    const px = frac * CH_W;
    if (px < M.left || px > CH_W - M.right) return setHover(null);
    const t = t0 + ((px - M.left) / plotW) * span;
    setHover({
      t,
      xFrac: (x(t) / CH_W),
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
        {/* series (clipped to the plot area) */}
        <defs>
          <clipPath id={`clip-${ride.id}`}>
            <rect x={M.left} y={M.top} width={plotW} height={plotH} />
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
              width={2}
              dotWidth={7}
              asOf={asOf}
            />
          ))}
        </g>
      </svg>

      {hover && hover.rows.some((r) => r.wait != null) && (
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
              <span className="chart-tip-swatch" style={{ background: r.colour }} />
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

  return (
    <div className={"q-row" + (open ? " open" : "")}>
      <button className="q-row-head" onClick={onToggle} aria-expanded={open}>
        <span className="q-name">{ride.name}</span>
        <Sparkline ride={ride} domain={domain} yMax={yMax} asOf={asOf} />
        <span className="q-now">
          {stats.current != null ? (
            <>
              <strong>{stats.current}</strong> min
            </>
          ) : (
            <span className="q-closed">Closed</span>
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
 * Rides carry the park's own thrill group ("Thrills", "Top Thrills", "Brave
 * Adventurers", …). We order the sections thrill-first regardless of the park's
 * own order (Chessington lists kids' rides first; we don't). Unidentified rides
 * (parent absent from the content bundle) get their own section, always last. */

function groupRank(group: string | undefined, unidentified: boolean): number {
  if (unidentified) return 1000;
  if (!group) return 500; // named but ungrouped (e.g. Legoland)
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
  rides: QueueRide[];
}

function sectionsOf(rides: QueueRide[], sort: SortMode): Section[] {
  const map = new Map<string, Section>();
  for (const ride of rides) {
    const unidentified = ride.named === false;
    const key = unidentified ? "__unidentified" : ride.group ?? "__other";
    const title = unidentified ? "Unidentified" : ride.group ?? "Other";
    let sec = map.get(key);
    if (!sec) map.set(key, (sec = { key, title, rank: groupRank(ride.group, unidentified), rides: [] }));
    sec.rides.push(ride);
  }
  const secs = [...map.values()];
  const cmp = rideComparator(sort);
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const sections = useMemo(() => sectionsOf(file?.rides ?? [], sort), [file, sort]);

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
              onClick={() => setSort(s.key)}
              aria-pressed={sort === s.key}
            >
              {s.label}
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
          <section key={sec.key} className="q-section" data-tone={sectionTone(sec.rank)}>
            <button
              className="q-section-head"
              onClick={() => toggleSection(sec.key)}
              aria-expanded={!isCollapsed}
            >
              <span className={"q-section-chevron" + (isCollapsed ? " collapsed" : "")}>
                ▾
              </span>
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
