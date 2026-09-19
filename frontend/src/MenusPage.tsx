import { useMemo, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { findPark, PARK_HOME } from "./catalog";
import MENUS from "./menus.generated.json";

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
  note: string | null;
  menuUrl: string | null;
  diningPlans: string[] | null;
  goneSince: string | null;
  passDiscount: PassDiscount | null;
  items: number;
  from: number | null;
  to: number | null;
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
  water: { slug: string; name: string }[];
  events: ParkEvent[];
  offers: Offer[];
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

function ItemRow({ item }: { item: Item }) {
  const unclear = item.unclear ? `Couldn't read this on the photo: ${item.unclear}` : undefined;
  const sizes = item.sizes ?? [];
  return (
    <li className="fd-item">
      <span className="fd-item-main">
        <span className="fd-item-name">
          {item.name}
          {(item.tags ?? []).map((t) => (
            <abbr key={t} className="fd-tag" title={TAG_LABEL[t] ?? t}>
              {t}
            </abbr>
          ))}
          {item.kcal != null && <span className="fd-kcal">{item.kcal} kcal</span>}
        </span>
        {item.description && <span className="fd-item-desc">{item.description}</span>}
        {/* A size ladder is its own little price list, not one long line. */}
        {sizes.length > 0 && (
          <span className="fd-sizes">
            {sizes.map((s, n) => (
              <span key={s.label + n} className="fd-size">
                <span className="fd-size-label">
                  {s.label}
                  {s.kcal != null && <span className="fd-kcal">{s.kcal} kcal</span>}
                </span>
                <span className="fd-price" title={unclear}>
                  {s.price == null ? "?" : money(s.price)}
                  {s.price == null && item.unclear && <span className="fd-flag">?</span>}
                </span>
              </span>
            ))}
          </span>
        )}
      </span>
      {sizes.length === 0 && (
        <span className="fd-price" title={unclear}>
          {item.price == null ? "?" : money(item.price)}
          {item.unclear && <span className="fd-flag">?</span>}
        </span>
      )}
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
  const detail = [pass.applies, why].filter(Boolean).join(" — ");
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

function VenueCard({ venue, query, openAt }: { venue: Venue; query: string; openAt?: string }) {
  const menu = venue.menus[0]; // newest visit
  // ?open=<slug> deep-links one venue, so a menu can be sent to someone.
  const [open, setOpen] = useState(openAt === venue.slug);
  // A search hides the sections that don't match, and opens what's left.
  const sections = useMemo(() => {
    if (!query) return menu.sections;
    return menu.sections
      .map((s) => ({ ...s, items: s.items.filter((i) => hay(i).includes(query)) }))
      .filter((s) => s.items.length);
  }, [menu.sections, query]);
  const hits = sections.reduce((n, s) => n + s.items.length, 0);
  const show = open || !!query;

  return (
    <section id={venue.slug} className={"fd-venue" + (show ? " open" : "")}>
      <button className="fd-venue-head" onClick={() => setOpen((v) => !v)} aria-expanded={show}>
        <span className="fd-venue-title">
          <span className="fd-venue-name">{venue.name}</span>
          <PassBadge pass={venue.passDiscount} />
          {venue.diningPlans?.map((p) => (
            <span key={p} className="fd-plan" title={`Merlin Dining Plan — ${p}`}>
              {p} plan
            </span>
          ))}
        </span>
        <span className="fd-venue-meta">
          {query
            ? `${hits} match${hits === 1 ? "" : "es"}`
            : `${venue.items} item${venue.items === 1 ? "" : "s"}`}
          {venue.from != null && (
            <>
              {" · "}
              {venue.from === venue.to ? money(venue.from) : `${money(venue.from)}–${money(venue.to!)}`}
            </>
          )}
        </span>
        <span className="fd-chevron" aria-hidden="true">
          {show ? "−" : "+"}
        </span>
      </button>
      {show && (
        <div className="fd-sections">
          {venue.note && <p className="fd-note">{venue.note}</p>}
          {sections.map((s) => (
            <div key={s.name} className="fd-section">
              <h4>{s.name}</h4>
              {s.note && <p className="fd-note">{s.note}</p>}
              <ul>
                {s.items.map((i, n) => (
                  <ItemRow key={i.name + n} item={i} />
                ))}
              </ul>
            </div>
          ))}
          {menu.offers.map((o, n) => (
            <p key={n} className="fd-offer">
              {o.text}
            </p>
          ))}
          <div className="fd-photos">
            <span className="fd-venue-meta">Seen {longDate(menu.date)}</span>
            {menu.photos.map((p) => (
              <a
                key={p.name}
                href={menu.base + p.name + ".jpg"}
                title={p.caption}
                target="_blank"
                rel="noreferrer noopener"
              >
                <img src={menu.base + p.name + ".jpg"} alt={p.caption} loading="lazy" />
              </a>
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

/** Venues under their park area, areas in alphabetical order. */
function AreaGroups({ venues, query, openAt }: { venues: Venue[]; query: string; openAt?: string }) {
  const areas = new Map<string, Venue[]>();
  for (const v of venues) {
    const key = v.area ?? "Elsewhere in the park";
    if (!areas.has(key)) areas.set(key, []);
    areas.get(key)!.push(v);
  }
  return (
    <>
      {[...areas].sort(([a], [b]) => a.localeCompare(b)).map(([area, list]) => (
        <section key={area} className="fd-area">
          <h3 className="fd-area-head">
            {area}
            <span className="fd-venue-meta">{list.length}</span>
          </h3>
          {list.map((v) => (
            <VenueCard key={v.slug} venue={v} query={query} openAt={openAt} />
          ))}
        </section>
      ))}
    </>
  );
}

export function MenusPage() {
  const { park } = useParams();
  const parkDef = findPark(park);
  const [params] = useSearchParams();
  const openAt = params.get("open") ?? undefined;
  const [q, setQ] = useState("");
  const [passOnly, setPassOnly] = useState(false);
  const [showGone, setShowGone] = useState(false);
  const data = park ? DATA[park] : undefined;
  if (!parkDef || !data) return <Navigate to={PARK_HOME} replace />;

  const query = q.trim().toLowerCase();
  const matches = (v: Venue) =>
    (!query ||
      v.name.toLowerCase().includes(query) ||
      (v.area ?? "").toLowerCase().includes(query) ||
      v.menus[0].sections.some((s) => s.items.some((i) => hay(i).includes(query)))) &&
    (!passOnly || v.passDiscount?.offered === true);

  // A venue whose only photo is a shop sign has a menu.json but no prices —
  // it belongs with the not-yet-photographed, not in the priced list.
  const transcribed = data.venues.filter((v) => v.menus.length && v.items > 0);
  const current = transcribed.filter((v) => !v.goneSince).filter(matches);
  const gone = transcribed.filter((v) => v.goneSince).filter(matches);
  // An event that has finished is history; one still running sits up top.
  const events = data.events
    .map((e) => ({ ...e, vendors: e.vendors.filter((v) => v.menus.length).filter(matches) }))
    .filter((e) => e.vendors.length);
  const running = events.filter((e) => !e.end || e.end >= TODAY);
  const past = events.filter((e) => e.end && e.end < TODAY);
  const without = data.venues.filter((v) => (!v.menus.length || v.items === 0) && !v.goneSince);
  const historic = gone.length + past.reduce((n, e) => n + e.vendors.length, 0);
  const found = current.length + running.reduce((n, e) => n + e.vendors.length, 0);

  return (
    <main className="fd">
      <p className="fd-intro">
        Menu boards photographed in the park and typed up. Each menu says when it was seen — prices move.
      </p>
      <div className="fd-controls">
        <input
          className="fd-search"
          type="search"
          value={q}
          placeholder="Search food, drink or a place"
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          className={"fd-chip" + (passOnly ? " on" : "")}
          onClick={() => setPassOnly((v) => !v)}
          aria-pressed={passOnly}
        >
          Pass discount
        </button>
      </div>

      {(query || passOnly) && (
        <p className="fd-count">
          {found} place{found === 1 ? "" : "s"}
          {historic > 0 && !showGone && " (plus history below)"}
        </p>
      )}

      {data.offers.length > 0 && !query && !passOnly && (
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
            <VenueCard key={v.slug} venue={v} query={query} openAt={openAt} />
          ))}
        </section>
      ))}

      {current.length > 0 ? (
        <AreaGroups venues={current} query={query} openAt={openAt} />
      ) : (
        <p className="fd-empty">
          {query || passOnly ? "Nothing open matches that." : "No menus yet for this park."}
        </p>
      )}

      {historic > 0 && (
        <section className="fd-historic">
          <button className="fd-toggle" onClick={() => setShowGone((v) => !v)} aria-expanded={showGone}>
            {showGone ? "−" : "+"} Food that has gone ({historic})
          </button>
          {showGone && (
            <>
              <p className="fd-note">
                Events that have ended and places the park's app no longer lists. Kept for the prices.
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
                    <VenueCard key={v.slug} venue={v} query={query} openAt={openAt} />
                  ))}
                </section>
              ))}
              {gone.length > 0 && <AreaGroups venues={gone} query={query} openAt={openAt} />}
            </>
          )}
        </section>
      )}

      {!query && !passOnly && without.length > 0 && (
        <details className="fd-more">
          <summary>Not photographed yet ({without.length})</summary>
          <ul>
            {without.map((v) => (
              <li key={v.slug}>
                {v.name}
                {v.area && <span className="fd-venue-meta"> {v.area}</span>}
                <PassBadge pass={v.passDiscount} />
              </li>
            ))}
          </ul>
        </details>
      )}

      {!query && !passOnly && data.water.length > 0 && (
        <details className="fd-more">
          <summary>Free water refills ({data.water.length})</summary>
          <ul>
            {data.water.map((w) => (
              <li key={w.slug}>{w.name}</li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}
