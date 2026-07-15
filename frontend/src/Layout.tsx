import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { findPark, PARKS } from "./catalog";

export function Layout() {
  const { park } = useParams();
  const navigate = useNavigate();
  const parkDef = findPark(park) ?? PARKS[0];

  return (
    <>
      <header>
        <div className="topbar">
          <h1>Merlin Capacity</h1>
          {PARKS.length > 1 ? (
            <select
              value={parkDef.key}
              onChange={(e) => {
                const p = PARKS.find((x) => x.key === e.target.value)!;
                navigate(`/${p.key}/${p.products[0].key}`);
              }}
            >
              {PARKS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          ) : (
            <span className="park-name">{parkDef.label}</span>
          )}
        </div>
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
