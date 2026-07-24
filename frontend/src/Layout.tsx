import { Link, NavLink, Outlet, useLocation, useParams } from "react-router-dom";
import { findPark, PARKS, type ParkDef } from "./catalog";

export function Layout() {
  const { park } = useParams();
  const parkDef = findPark(park) ?? PARKS[0];

  // The path segments after the park (e.g. ["main"], ["queues"], ["queues",
  // "2026-07-18"]), used to keep you on the same page when you switch parks.
  const { pathname } = useLocation();
  const rest = pathname.split("/").filter(Boolean).slice(1);
  const section = rest[0]; // undefined (calendar) | "queues" | a product key

  // Where a given park's nav link should point. Switching parks keeps the same
  // page WHEN the target park has it — otherwise the product route wouldn't match
  // and CalendarPage would bounce to the default park. So: a product tab is only
  // carried over to a park that actually has that product; the Calendar and
  // Queues tabs exist for every (non-queue-only) park.
  const targetFor = (p: ParkDef): string => {
    if (p.queueOnly) return `/${p.key}/queues`; // no calendar/products — always queues
    if (!section) return `/${p.key}`; // calendar home
    if (section === "queues") return `/${p.key}/${rest.join("/")}`; // queues (+ date)
    if (p.products.some((pr) => pr.key === section)) return `/${p.key}/${section}`;
    return `/${p.key}`; // this park doesn't have that product → its calendar home
  };

  return (
    <>
      <header>
        <h1>Theme Parks</h1>
        <nav className="parks">
          {PARKS.map((p) => (
            <Link
              key={p.key}
              to={targetFor(p)}
              className={"park-link" + (p.key === parkDef.key ? " active" : "")}
            >
              {p.label}
            </Link>
          ))}
        </nav>
        <nav className="tabs">
          {/* Rich calendar (park home), then per-product heatmaps. A queue-only
              park (Paulton's) has neither — just the Queues tab. */}
          {!parkDef.queueOnly && (
            <NavLink
              end
              to={`/${parkDef.key}`}
              className={({ isActive }) => "tab" + (isActive ? " active" : "")}
            >
              Calendar
            </NavLink>
          )}
          {/* Ride queue times (stays active on the /queues/:date history URLs). */}
          <NavLink
            to={`/${parkDef.key}/queues`}
            className={({ isActive }) => "tab" + (isActive ? " active" : "")}
          >
            Queues
          </NavLink>
          {parkDef.products.map((pr) => (
            <NavLink
              key={pr.key}
              to={`/${parkDef.key}/${pr.key}`}
              className={({ isActive }) => "tab" + (isActive ? " active" : "")}
            >
              {pr.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <Outlet />
    </>
  );
}
