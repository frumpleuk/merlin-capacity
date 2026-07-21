import { Link, NavLink, Outlet, useLocation, useParams } from "react-router-dom";
import { findPark, PARKS } from "./catalog";

export function Layout() {
  const { park } = useParams();
  const parkDef = findPark(park) ?? PARKS[0];

  // Everything after the park segment (e.g. "queues", "main", "queues/2026-07-18"),
  // so switching parks keeps you on the same page.
  const { pathname } = useLocation();
  const suffix = pathname.split("/").filter(Boolean).slice(1).join("/");

  return (
    <>
      <header>
        <h1>Theme Parks</h1>
        <nav className="parks">
          {PARKS.map((p) => (
            <Link
              key={p.key}
              // A queue-only park has no calendar/product pages, so always land
              // it on its Queues tab (and never carry a ticket suffix onto it).
              to={p.queueOnly ? `/${p.key}/queues` : suffix ? `/${p.key}/${suffix}` : `/${p.key}`}
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
