import { Navigate, NavLink, Outlet, useLocation } from "react-router-dom";
import { findPark, parkPath, PARKS, type ParkDef } from "./catalog";
import { PARK_LINKS } from "./links";
import { ParkPicker } from "./ParkPicker";
import { ParkTimeZoneContext } from "./parkDay";
import { useParkKey } from "./useParkKey";
import MENUS from "./menus.index.json";

type MenuCounts = Record<string, { venues: number; water: number }>;

/** A park earns the Food tab once we know anything about eating there — the
 *  places from its app count, with or without a photographed menu, and so do
 *  the free water refills. */
function hasFood(park: string): boolean {
  const d = (MENUS as MenuCounts)[park];
  return !!d && (d.venues > 0 || d.water > 0);
}

export function Layout() {
  const parkDef = findPark(useParkKey()) ?? PARKS[0];
  const base = parkPath(parkDef);

  // The path segments after /<country>/<slug> (e.g. ["main"], ["queues"],
  // ["queues", "2026-07-18"]), used to keep you on the same page when you
  // switch parks.
  const { pathname } = useLocation();
  const rest = pathname.split("/").filter(Boolean).slice(2);
  const section = rest[0]; // undefined (calendar) | "queues" | a product key

  // Where a given park's nav link should point. Switching parks keeps the same
  // page WHEN the target park has it — otherwise the product route wouldn't match
  // and CalendarPage would bounce to the default park. So: a product tab is only
  // carried over to a park that actually has that product; the Calendar and
  // Queues tabs exist for every (non-queue-only) park.
  const targetFor = (p: ParkDef): string => {
    // Links come before the queue-only check: every park has a link directory,
    // whether or not it has a calendar.
    if (section === "links" && PARK_LINKS[p.key]) return `${parkPath(p)}/links`;
    // Food & Drink exists wherever we have the park's outlets or its water.
    if (section === "food" && hasFood(p.key)) return `${parkPath(p)}/food`;
    if (p.queueOnly) return `${parkPath(p)}/queues`; // no calendar/products — always queues
    if (!section) return parkPath(p); // calendar home
    if ((section === "queues" || section === "uptime") && p.noQueues) return parkPath(p);
    if (section === "queues") return `${parkPath(p)}/${rest.join("/")}`; // queues (+ date)
    // Uptime exists wherever queues do — it's derived from the same files.
    if (section === "uptime") return `${parkPath(p)}/uptime`;
    if (p.products.some((pr) => pr.key === section)) return `${parkPath(p)}/${section}`;
    return parkPath(p); // this park doesn't have that product → its calendar home
  };

  if ((section === "queues" || section === "uptime") && parkDef.noQueues)
    return <Navigate to={base} replace />;

  return (
    <>
      <header>
        <h1>Theme Parks</h1>
        <ParkPicker current={parkDef} hrefFor={targetFor} />
        <nav className="tabs">
          {/* Rich calendar (park home), then per-product heatmaps. A queue-only
              park (Paulton's) has neither — just the Queues tab. */}
          {!parkDef.queueOnly && (
            <NavLink
              end
              to={base}
              className={({ isActive }) => "tab" + (isActive ? " active" : "")}
            >
              Calendar
            </NavLink>
          )}
          {/* Ride queue times (stays active on the /queues/:date history URLs). */}
          {!parkDef.noQueues && (
            <NavLink
              to={`${base}/queues`}
              className={({ isActive }) => "tab" + (isActive ? " active" : "")}
            >
              Queues
            </NavLink>
          )}
          {/* How often the rides actually run — same source as Queues, so every
              park that has one has the other. "Uptime" rather than
              "Availability": this app already spends that word on TICKET
              availability, and the two sit one tab apart. */}
          {!parkDef.noQueues && (
            <NavLink
              to={`${base}/uptime`}
              className={({ isActive }) => "tab" + (isActive ? " active" : "")}
            >
              Uptime
            </NavLink>
          )}
          {parkDef.products.map((pr) => (
            <NavLink
              key={pr.key}
              to={`${base}/${pr.key}`}
              className={({ isActive }) => "tab" + (isActive ? " active" : "")}
            >
              {pr.label}
            </NavLink>
          ))}
          {/* Where to eat and drink: menu prices typed up from photos of the
              boards, every outlet the park's app lists, and the free water. */}
          {hasFood(parkDef.key) && (
            <NavLink
              to={`${base}/food`}
              className={({ isActive }) => "tab" + (isActive ? " active" : "")}
            >
              Food &amp; Drink
            </NavLink>
          )}
          {/* Static link directory (booking, accessibility, apps, socials) —
              last, since it's reference material rather than live data. */}
          {PARK_LINKS[parkDef.key] && (
            <NavLink
              to={`${base}/links`}
              className={({ isActive }) => "tab" + (isActive ? " active" : "")}
            >
              Links
            </NavLink>
          )}
        </nav>
      </header>
      <ParkTimeZoneContext.Provider value={parkDef.timeZone ?? "Europe/London"}>
        <Outlet />
      </ParkTimeZoneContext.Provider>
    </>
  );
}
