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
              to={`/${p.key}/${p.products[0].key}`}
              className={"park-link" + (p.key === parkDef.key ? " active" : "")}
            >
              {p.label}
            </Link>
          ))}
        </nav>
        <nav className="tabs">
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
