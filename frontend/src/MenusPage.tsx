import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { findPark, PARK_HOME } from "./catalog";
import MENUS from "./menus.generated.json";
import { ParkMap, type MapArea } from "./ParkMap";

// Shape of menus.generated.json (built from contrib/menus by scripts/menus/build.mjs).
interface Size {
  label: string;
  price: number | null;
  kcal?: number;
}
interface Item {
  name: string;
  description?: string;
  price?: number | null;
  sizes?: Size[];
  kcal?: number;
  tags?: string[];
  unclear?: string;
}
interface Section {
  name: string;
  note?: string;
  items: Item[];
}
interface Offer {
  text: string;
  date?: string;
}
interface Menu {
  date: string;
  /** R2 path the web photos hang off, e.g. /menus/alton-towers/donut-division/2026-08-26/ */
  base: string;
  photos: { name: string; caption: string }[];
  sections: Section[];
  offers: Offer[];
}
/** What a Merlin Annual Pass gets you at a venue. */
interface PassDiscount {
  offered: boolean;
  percent?: number | null;
  /** The sign says "up to 20% off" rather than a flat rate — don't over-promise. */
  upTo?: boolean;
  applies?: string;
  source?: string;
}
interface Venue {
  slug: string;
  name: string;
  area: string | null;
  category: string | null;
  note: string | null;
  menuUrl: string | null;
  diningPlans: string[] | null;
  goneSince: string | null;
  passDiscount: PassDiscount | null;
  lat: number | null;
  lon: number | null;
  items: number;
  from: number | null;
  to: number | null;
  event?: string;
  menus: Menu[];
}
interface ParkEvent {
  slug: string;
  name: string;
  area?: string | null;
  start?: string | null;
  end?: string | null;
  discount?: string | null;
  note?: string | null;
  vendors: Venue[];
}
interface ParkMenus {
  venues: Venue[];
  water: { slug: string; name: string; lat: number | null; lon: number | null }[];
  events: ParkEvent[];
  offers: Offer[];
  areas: MapArea[];
}

const DATA = MENUS as Record<string, ParkMenus>;
const TODAY = new Date().toISOString().slice(0, 10);

/** Prices are stored as integer pence — "875" reads as £8.75, "500" as £5. */
const money = (p: number) => "£" + (p / 100).toFixed(2).replace(/\.00$/, "");

const TAG_LABEL: Record<string, string> = {
  v: "vegetarian",
  vg: "vegan",
  gf: "gluten free",
  df: "dairy free",
  alcohol: "alcohol",
  kids: "kids",
};

const longDate = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

const hay = (i: Item) => (i.name + " " + (i.description ?? "")).toLowerCase();
/** "Food & Drink > Snacks" files under Snacks. The bare top-level category
 *  says nothing (every venue is food), so it reads as "Other". */
const kindOf = (v: Venue) => {
  const tail = v.category?.split(">").pop()?.trim();
  if (!tail) return null;
  return /^(Food & Drink|Dining)$/.test(tail) ? "Other" : tail;
};
/** Flags that aren't a place or a category, but are worth filtering on. */
const perksOf = (v: Venue) => [
  ...(v.passDiscount?.offered ? ["Pass discount"] : []),
  ...(v.passDiscount?.offered === false ? ["No pass discount"] : []),
  ...(v.menuUrl ? ["Official menu"] : []),
];

/** A photo opened from a menu, with where and when it was taken. */
interface Shot {
  venue: string;
  area: string | null;
  date: string;
  base: string;
  photos: { name: string; caption: string }[];
  at: number;
}

function Lightbox({ shot, onClose }: { shot: Shot; onClose: () => void }) {
  const [at, setAt] = useState(shot.at);
  const [zoom, setZoom] = useState(1);
  const stage = useRef<HTMLDivElement>(null);
  const photo = shot.photos[at];
  const many = shot.photos.length > 1;

  const step = (by: number) => {
    setAt((n) => (n + by + shot.photos.length) % shot.photos.length);
    setZoom(1); // a new board starts fitted
  };
  // Zoom about the middle of what you are looking at, so the detail you were
  // reading doesn't shoot off the edge.
  const setZoomAt = (next: number) => {
    const el = stage.current;
    const from = zoom;
    setZoom(next);
    if (!el) return;
    requestAnimationFrame(() => {
      const k = next / from;
      el.scrollLeft = (el.scrollLeft + el.clientWidth / 2) * k - el.clientWidth / 2;
      el.scrollTop = (el.scrollTop + el.clientHeight / 2) * k - el.clientHeight / 2;
    });
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && many) step(1);
      if (e.key === "ArrowLeft" && many) step(-1);
      if (e.key === "+" || e.key === "=") setZoomAt(Math.min(4, zoom * 1.5));
      if (e.key === "-") setZoomAt(Math.max(1, zoom / 1.5));
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });

  // Drag to pan once zoomed in.
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onDown = (e: ReactPointerEvent) => {
    if (zoom === 1 || !stage.current) return;
    drag.current = { x: e.clientX, y: e.clientY, left: stage.current.scrollLeft, top: stage.current.scrollTop };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || !stage.current) return;
    stage.current.scrollLeft = d.left - (e.clientX - d.x);
    stage.current.scrollTop = d.top - (e.clientY - d.y);
  };

  return (
    <div className="fd-lb" role="dialog" aria-modal="true" aria-label={photo.caption} onClick={onClose}>
      <div className="fd-lb-inner" onClick={(e) => e.stopPropagation()}>
        {/* Arrows flank the photo and the close sits top right, where a photo
            viewer puts them. */}
        <button className="fd-lb-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        {many && (
          <>
            <button className="fd-lb-arrow prev" onClick={() => step(-1)} aria-label="Previous photo">
              ‹
            </button>
            <button className="fd-lb-arrow next" onClick={() => step(1)} aria-label="Next photo">
              ›
            </button>
          </>
        )}
        <div
          className={"fd-lb-stage" + (zoom > 1 ? " zoomed" : "")}
          ref={stage}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={() => (drag.current = null)}
          onDoubleClick={() => setZoomAt(zoom > 1 ? 1 : 2.5)}
        >
          <img
            src={shot.base + photo.name + ".jpg"}
            alt={photo.caption}
            style={zoom > 1 ? { width: `${zoom * 100}%`, maxHeight: "none" } : undefined}
            draggable={false}
          />
        </div>
        <div className="fd-lb-meta">
          <strong>{shot.venue}</strong>
          <span className="fd-venue-meta">
            {shot.area ? `${shot.area}, ` : ""}
            photographed {longDate(shot.date)}
          </span>
          <span className="fd-lb-caption">{photo.caption}</span>
          <span className="fd-lb-actions">
            {many && (
              <span className="fd-venue-meta">
                {at + 1} of {shot.photos.length}
              </span>
            )}
            <button onClick={() => setZoomAt(Math.max(1, zoom / 1.5))} disabled={zoom === 1} aria-label="Zoom out">
              −
            </button>
            <button onClick={() => setZoomAt(Math.min(4, zoom * 1.5))} disabled={zoom >= 4} aria-label="Zoom in">
              +
            </button>
            <a href={shot.base + photo.name + ".jpg"} target="_blank" rel="noreferrer noopener">
              Full size
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Show where the search matched, so a hit in a long menu is findable. */
function Mark({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const at = text.toLowerCase().indexOf(query);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="fd-mark">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

function ItemRow({ item, query }: { item: Item; query: string }) {
  const unclear = item.unclear ? `Couldn't read this on the photo: ${item.unclear}` : undefined;
  const sizes = item.sizes ?? [];
  return (
    <li className="fd-item">
      <span className="fd-line">
        <span className="fd-item-name">
          <Mark text={item.name} query={query} />
          {item.unclear && item.price != null && (
            <abbr className="fd-unsure" title={unclear}>
              ?
            </abbr>
          )}
          {(item.tags ?? []).map((t) => (
            <abbr key={t} className="fd-tag" title={TAG_LABEL[t] ?? t}>
              {t}
            </abbr>
          ))}
          {item.kcal != null && <span className="fd-kcal">{item.kcal} kcal</span>}
        </span>
        {sizes.length === 0 && (
          <span className="fd-price" title={unclear}>
            {item.price == null ? <span className="fd-flag">?</span> : money(item.price)}
          </span>
        )}
      </span>
      {item.description && (
        <span className="fd-item-desc">
          <Mark text={item.description} query={query} />
        </span>
      )}
      {/* A size ladder is its own little price list, not one long line. */}
      {sizes.map((s, n) => (
        <span key={s.label + n} className="fd-line fd-size">
          <span className="fd-size-label">
            {s.label}
            {s.kcal != null && <span className="fd-kcal">{s.kcal} kcal</span>}
          </span>
          <span className="fd-price" title={unclear}>
            {s.price == null ? <span className="fd-flag">?</span> : money(s.price)}
          </span>
        </span>
      ))}
    </li>
  );
}

/** The pass badge: the thing a passholder scans this page for. */
function PassBadge({ pass }: { pass: PassDiscount | null }) {
  if (!pass) return null;
  const why =
    pass.source === "user report"
      ? "reported, not from a photo"
      : pass.source === "park app"
        ? "from the park's app, no rate given"
        : null;
  const detail = [pass.applies, why].filter(Boolean).join(", ");
  if (!pass.offered) {
    return (
      <span className="fd-pass fd-pass-no" title={detail || undefined}>
        no pass discount
      </span>
    );
  }
  return (
    <span className="fd-pass" title={detail || undefined}>
      {pass.percent != null ? `${pass.upTo ? "up to " : ""}${pass.percent}% pass` : "pass discount"}
    </span>
  );
}

function VenueCard({
  venue,
  query,
  focus,
  onOpen,
  onShot,
}: {
  venue: Venue;
  query: string;
  focus?: string;
  onOpen: (slug: string | null) => void;
  onShot: (shot: Shot) => void;
}) {
  const menu = venue.menus[0] as Menu | undefined; // newest visit, if we have one
  const [open, setOpen] = useState(focus === venue.slug);
  const ref = useRef<HTMLElement>(null);

  // Picked on the map (or deep-linked): open it and bring it into view.
  useEffect(() => {
    if (focus !== venue.slug) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus, venue.slug]);

  // A search hides the sections that don't match, and opens what's left.
  const sections = useMemo(() => {
    if (!menu) return [];
    if (!query) return menu.sections;
    return menu.sections
      .map((s) => ({ ...s, items: s.items.filter((i) => hay(i).includes(query)) }))
      .filter((s) => s.items.length);
  }, [menu, query]);
  const hits = sections.reduce((n, s) => n + s.items.length, 0);
  const priced = venue.items > 0 && !!menu;
  const show = priced && (open || !!query);
  // One note repeated on every section (a tablet's "this list may be partial")
  // is really the venue's note — say it once.
  const shared =
    sections.length > 1 && sections.every((s) => s.note && s.note === sections[0].note)
      ? sections[0].note
      : null;

  return (
    <section
      ref={ref}
      id={venue.slug}
      className={"fd-venue" + (show ? " open" : "") + (priced ? "" : " fd-unseen")}
    >
      <button
        className="fd-venue-head"
        disabled={!priced}
        onClick={() => {
          setOpen(!show);
          onOpen(show ? null : venue.slug);
        }}
        aria-expanded={show}
      >
        <span className="fd-venue-title">
          <span className="fd-venue-name">{venue.name}</span>
          <PassBadge pass={venue.passDiscount} />
          {venue.diningPlans?.map((p) => (
            <span key={p} className="fd-plan" title={`Merlin Dining Plan: ${p}`}>
              {p} plan
            </span>
          ))}
        </span>
        <span className="fd-venue-meta">
          {!priced
            ? "no menu yet"
            : query
              ? `${hits} match${hits === 1 ? "" : "es"}`
              : `${venue.items} item${venue.items === 1 ? "" : "s"}`}
          {priced && venue.from != null && (
            <>
              {" · "}
              {venue.from === venue.to ? money(venue.from) : `${money(venue.from)} to ${money(venue.to!)}`}
            </>
          )}
        </span>
        <span className="fd-chevron" aria-hidden="true">
          {priced ? (show ? "−" : "+") : ""}
        </span>
      </button>
      {show && menu && (
        <div className="fd-sections">
          {venue.note && <p className="fd-note">{venue.note}</p>}
          {shared && <p className="fd-note">{shared}</p>}
          <div className="fd-menu">
            {sections.map((s) => (
              <div key={s.name} className="fd-section">
                <h4>{s.name}</h4>
                {s.note && s.note !== shared && <p className="fd-note">{s.note}</p>}
                <ul>
                  {s.items.map((i, n) => (
                    <ItemRow key={i.name + n} item={i} query={query} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {menu.offers.map((o, n) => (
            <p key={n} className="fd-offer">
              {o.text}
            </p>
          ))}
          <div className="fd-photos">
            <span className="fd-venue-meta">Seen {longDate(menu.date)}</span>
            {menu.photos.map((p, n) => (
              <button
                key={p.name}
                className="fd-thumb"
                title={p.caption}
                onClick={() =>
                  onShot({
                    venue: venue.name,
                    area: venue.area,
                    date: menu.date,
                    base: menu.base,
                    photos: menu.photos,
                    at: n,
                  })
                }
              >
                <img src={menu.base + p.name + ".jpg"} alt={p.caption} loading="lazy" />
              </button>
            ))}
            {venue.menuUrl && (
              <a className="fd-official" href={venue.menuUrl} target="_blank" rel="noreferrer noopener">
                Official menu
              </a>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** One park area, folded up until you ask for it (or a search opens it). */
function AreaGroup({
  area,
  venues,
  query,
  openAll,
  focus,
  onOpen,
  onShot,
}: {
  area: string;
  venues: Venue[];
  query: string;
  openAll: boolean;
  focus?: string;
  onOpen: (slug: string | null) => void;
  onShot: (shot: Shot) => void;
}) {
  const holdsFocus = venues.some((v) => v.slug === focus);
  const [open, setOpen] = useState(holdsFocus);
  useEffect(() => {
    if (holdsFocus) setOpen(true);
  }, [holdsFocus]);
  const show = open || openAll;
  const prices = venues.flatMap((v) => (v.from == null ? [] : [v.from]));

  return (
    <section className="fd-area">
      <button className="fd-area-head" onClick={() => setOpen((v) => !v)} aria-expanded={show}>
        <span className="fd-chevron" aria-hidden="true">
          {show ? "−" : "+"}
        </span>
        {area}
        <span className="fd-venue-meta">
          {venues.length} place{venues.length === 1 ? "" : "s"}
          {prices.length > 0 && ` · from ${money(Math.min(...prices))}`}
        </span>
      </button>
      {show &&
        venues.map((v) => (
          <VenueCard key={v.slug} venue={v} query={query} focus={focus} onOpen={onOpen} onShot={onShot} />
        ))}
    </section>
  );
}

/** Venues under their park area, areas in alphabetical order. */
function AreaGroups({
  venues,
  query,
  openAll,
  focus,
  onOpen,
  onShot,
}: {
  venues: Venue[];
  query: string;
  openAll: boolean;
  focus?: string;
  onOpen: (slug: string | null) => void;
  onShot: (shot: Shot) => void;
}) {
  const byArea = new Map<string, Venue[]>();
  for (const v of venues) {
    const key = v.area ?? "Elsewhere in the park";
    if (!byArea.has(key)) byArea.set(key, []);
    byArea.get(key)!.push(v);
  }
  return (
    <>
      {[...byArea].sort(([a], [b]) => a.localeCompare(b)).map(([area, list]) => (
        <AreaGroup
          key={area}
          area={area}
          venues={list}
          query={query}
          openAll={openAll}
          focus={focus}
          onOpen={onOpen}
          onShot={onShot}
        />
      ))}
    </>
  );
}

/** One filter facet: chips with how many places each would leave you. */
function Facet({
  label,
  values,
  counts,
  chosen,
  onToggle,
}: {
  label: string;
  values: string[];
  counts: Map<string, number>;
  chosen: Set<string>;
  onToggle: (value: string) => void;
}) {
  if (values.length < 2) return null;
  return (
    <div className="fd-facet">
      <h4>{label}</h4>
      <div className="fd-chips">
        {values.map((v) => (
          <button
            key={v}
            className={"fd-chip" + (chosen.has(v) ? " on" : "")}
            aria-pressed={chosen.has(v)}
            onClick={() => onToggle(v)}
          >
            {v}
            <span className="fd-chip-n">{counts.get(v) ?? 0}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function MenusPage() {
  const { park } = useParams();
  const parkDef = findPark(park);
  const [params, setParams] = useSearchParams();
  // The search lives in the URL, so a "where can I get chips" link is sendable.
  const q = params.get("q") ?? "";
  const [areas, setAreas] = useState<Set<string>>(new Set());
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [plans, setPlans] = useState<Set<string>>(new Set());
  const [perks, setPerks] = useState<Set<string>>(new Set());
  const [showGone, setShowGone] = useState(false);
  const [shot, setShot] = useState<Shot | null>(null);
  const data = park ? DATA[park] : undefined;

  const focus = params.get("open") ?? undefined;
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const setFocus = (slug: string | null) => setParam("open", slug);

  if (!parkDef || !data) return <Navigate to={PARK_HOME} replace />;

  const query = q.trim().toLowerCase();
  const facetsOf = (v: Venue) => ({
    area: v.area ? [v.area] : [],
    kind: kindOf(v) ? [kindOf(v)!] : [],
    plan: v.diningPlans ?? [],
    perk: perksOf(v),
  });
  // A venue must match one chosen chip in each facet the user has touched.
  const passes = (v: Venue) => {
    const f = facetsOf(v);
    const anyOf = (chosen: Set<string>, have: string[]) => chosen.size === 0 || have.some((x) => chosen.has(x));
    return (
      anyOf(areas, f.area) &&
      anyOf(kinds, f.kind) &&
      anyOf(plans, f.plan) &&
      anyOf(perks, f.perk) &&
      (!query ||
        v.name.toLowerCase().includes(query) ||
        (v.area ?? "").toLowerCase().includes(query) ||
        v.menus[0]?.sections.some((s) => s.items.some((i) => hay(i).includes(query))))
    );
  };

  const transcribed = data.venues;
  const eventVendors = data.events.flatMap((e) => e.vendors.filter((v) => v.menus.length && v.items > 0));
  const all = [...transcribed, ...eventVendors];
  // The map shows every food place the park's app lists, photographed or not.
  const pins = all.map((v) => ({ ...v, priced: v.items > 0 }));

  // A chip's count ignores its own facet, so it says what picking it would
  // leave rather than what is already selected.
  const countBy = (pick: (v: Venue) => string[], ignore: Set<string>) => {
    const counts = new Map<string, number>();
    for (const v of all) {
      const f = facetsOf(v);
      const ok =
        (ignore === areas || areas.size === 0 || f.area.some((x) => areas.has(x))) &&
        (ignore === kinds || kinds.size === 0 || f.kind.some((x) => kinds.has(x))) &&
        (ignore === plans || plans.size === 0 || f.plan.some((x) => plans.has(x))) &&
        (ignore === perks || perks.size === 0 || f.perk.some((x) => perks.has(x)));
      if (!ok) continue;
      for (const key of pick(v)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const valuesOf = (pick: (v: Venue) => string[]) =>
    [...new Set(all.flatMap(pick))].sort((a, b) => a.localeCompare(b));

  const toggle = (set: Set<string>, put: (s: Set<string>) => void) => (v: string) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    put(next);
  };
  const filtered = areas.size + kinds.size + plans.size + perks.size > 0;
  const clear = () => {
    setAreas(new Set());
    setKinds(new Set());
    setPlans(new Set());
    setPerks(new Set());
  };

  const byPrices = (a: Venue, b: Venue) =>
    Number(b.items > 0) - Number(a.items > 0) || a.name.localeCompare(b.name);
  const current = transcribed.filter((v) => !v.goneSince).filter(passes).sort(byPrices);
  const gone = transcribed.filter((v) => v.goneSince).filter(passes);
  const events = data.events
    .map((e) => ({ ...e, vendors: e.vendors.filter((v) => v.menus.length && v.items > 0).filter(passes) }))
    .filter((e) => e.vendors.length);
  const running = events.filter((e) => !e.end || e.end >= TODAY);
  const past = events.filter((e) => e.end && e.end < TODAY);
  const historic = gone.length + past.reduce((n, e) => n + e.vendors.length, 0);
  const shown = [...current, ...running.flatMap((e) => e.vendors)];
  const matched = new Set(shown.map((v) => v.slug));
  const withMenus = shown.filter((v) => v.items > 0).length;

  return (
    <main className="fd">
      {shot && <Lightbox shot={shot} onClose={() => setShot(null)} />}
      <div className="fd-controls">
        <input
          className="fd-search"
          type="search"
          value={q}
          placeholder="Search food, drink or a place"
          onChange={(e) => setParam("q", e.target.value)}
        />
        <span className="fd-count">
          {shown.length} place{shown.length === 1 ? "" : "s"} · {withMenus} with prices
          {historic > 0 && ` · ${historic} gone`}
        </span>
      </div>

      <div className="fd-layout">
        <aside className="fd-side">
          <ParkMap
            park={park!}
            venues={pins}
            water={data.water}
            areas={data.areas}
            matched={matched}
            focus={focus}
            onPick={setFocus}
          />
          <p className="fd-map-note">Tap a dot to open that menu; faded dots are filtered out.</p>
          {data.water.length > 0 && (
            <div className="fd-facet fd-water">
              <h4>Free water refills ({data.water.length})</h4>
              <div className="fd-chips">
                {data.water.map((w) => (
                  <button
                    key={w.slug}
                    className={"fd-chip fd-water-chip" + (focus === w.slug ? " on" : "")}
                    onClick={() => setFocus(focus === w.slug ? null : w.slug)}
                    title="Show on the map"
                  >
                    {/* The park names these "Water Refill (Dark Forest)" — the
                        useful half is where it is. */}
                    {w.name.replace(/^water\s*(refills?|fountain|refill station)?\s*/i, "").replace(/^[-–(]\s*/, "").replace(/\)$/, "") || w.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <Facet
            label="Area"
            values={valuesOf((v) => (v.area ? [v.area] : []))}
            counts={countBy((v) => (v.area ? [v.area] : []), areas)}
            chosen={areas}
            onToggle={toggle(areas, setAreas)}
          />
          <Facet
            label="Kind"
            values={valuesOf((v) => (kindOf(v) ? [kindOf(v)!] : []))}
            counts={countBy((v) => (kindOf(v) ? [kindOf(v)!] : []), kinds)}
            chosen={kinds}
            onToggle={toggle(kinds, setKinds)}
          />
          <Facet
            label="Dining plan"
            values={valuesOf((v) => v.diningPlans ?? [])}
            counts={countBy((v) => v.diningPlans ?? [], plans)}
            chosen={plans}
            onToggle={toggle(plans, setPlans)}
          />
          <Facet
            label="Perks"
            values={valuesOf(perksOf)}
            counts={countBy(perksOf, perks)}
            chosen={perks}
            onToggle={toggle(perks, setPerks)}
          />
          {filtered && (
            <button className="fd-clear" onClick={clear}>
              Clear filters
            </button>
          )}
        </aside>

        <div className="fd-list">
          <p className="fd-intro">
            Prices read off photos of the boards, with the date each was taken. Includes pop-ups and event
            stalls the park's app misses.
          </p>

          {data.offers.length > 0 && !query && !filtered && (
            <details className="fd-more fd-park-offers">
              <summary>Passholder deals across the park ({data.offers.length})</summary>
              {data.offers.map((o, n) => (
                <p key={n} className="fd-offer">
                  {o.text}
                  {o.date && <span className="fd-venue-meta"> · seen {longDate(o.date)}</span>}
                </p>
              ))}
            </details>
          )}

          {running.map((e) => (
            <section key={e.slug} className="fd-event">
              <h3 className="fd-area-head">
                {e.name}
                <span className="fd-venue-meta">
                  {e.area ? ` ${e.area}` : ""}
                  {e.end ? ` · until ${longDate(e.end)}` : ""}
                </span>
              </h3>
              {e.discount && <p className="fd-offer">{e.discount}</p>}
              {e.vendors.map((v) => (
                <VenueCard
                  key={v.slug}
                  venue={v}
                  query={query}
                  focus={focus}
                  onOpen={setFocus}
                  onShot={setShot}
                />
              ))}
            </section>
          ))}

          {current.length > 0 ? (
            <AreaGroups
              venues={current}
              query={query}
              openAll={!!query || filtered}
              focus={focus}
              onOpen={setFocus}
              onShot={setShot}
            />
          ) : (
            <p className="fd-empty">
              {query || filtered ? "Nothing open matches that." : "No menus yet for this park."}
            </p>
          )}

          {historic > 0 && (
            <section className="fd-historic">
              <button className="fd-toggle" onClick={() => setShowGone((v) => !v)} aria-expanded={showGone}>
                {showGone ? "−" : "+"} No longer there ({historic})
              </button>
              {showGone && (
                <>
                  <p className="fd-note">
                    Events that have ended, and places the park's app no longer lists, kept for their prices.
                  </p>
                  {past.map((e) => (
                    <section key={e.slug} className="fd-event">
                      <h3 className="fd-area-head">
                        {e.name}
                        <span className="fd-venue-meta">
                          {e.area ? ` ${e.area}` : ""}
                          {e.end ? ` · ended ${longDate(e.end)}` : ""}
                        </span>
                      </h3>
                      {e.note && <p className="fd-note">{e.note}</p>}
                      {e.discount && <p className="fd-offer">{e.discount}</p>}
                      {e.vendors.map((v) => (
                        <VenueCard
                          key={v.slug}
                          venue={v}
                          query={query}
                          focus={focus}
                          onOpen={setFocus}
                          onShot={setShot}
                        />
                      ))}
                    </section>
                  ))}
                  {gone.length > 0 && (
                    <AreaGroups
                      venues={gone}
                      query={query}
                      openAll={!!query || filtered}
                      focus={focus}
                      onOpen={setFocus}
                      onShot={setShot}
                    />
                  )}
                </>
              )}
            </section>
          )}


        </div>
      </div>
    </main>
  );
}
