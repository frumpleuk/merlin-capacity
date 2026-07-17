import { Link, NavLink, Outlet, useParams } from "react-router-dom";
import { findPark, PARKS } from "./catalog";

export function Layout() {
  const { park } = useParams();
  const parkDef = findPark(park) ?? PARKS[0];

  return (
    <>
      <header>
        <h1>Merlin Capacity</h1>
        <nav className="parks">
          {PARKS.map((p) => (
            <Link
              key={p.key}
              to={`/${p.key}`}
              className={"park-link" + (p.key === parkDef.key ? " active" : "")}
            >
              {p.label}
            </Link>
          ))}
        </nav>
        <nav className="tabs">
          {/* Rich calendar (park home), then per-product heatmaps. */}
          <NavLink
            end
            to={`/${parkDef.key}`}
            className={({ isActive }) => "tab" + (isActive ? " active" : "")}
          >
            Calendar
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
