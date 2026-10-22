import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { CalendarPage } from "./CalendarPage";
import { findPark, PARK_HOME, parkPath } from "./catalog";
import { Layout } from "./Layout";
import { LinksPage } from "./LinksPage";
import { MenusPage } from "./MenusPage";
import { ParkCalendarPage } from "./ParkCalendarPage";
import { QueuesPage } from "./QueuesPage";
import { UptimePage } from "./UptimePage";
import { useParkKey } from "./useParkKey";

/** …/reliability → …/uptime, preserving the park. */
function RedirectToUptime() {
  const { country, slug } = useParams();
  return <Navigate to={`/${country}/${slug}/uptime`} replace />;
}

/** URLs from before the country code went in were /<key>/<tab>
 *  (/alton_towers/queues/2026-07-18). Send them to the same page at the new
 *  address; anything else goes to the default park. */
function LegacyRedirect() {
  const { pathname, search } = useLocation();
  const [first, ...rest] = pathname.split("/").filter(Boolean);
  const park = findPark(first);
  if (!park) return <Navigate to={PARK_HOME} replace />;
  if (rest[0] === "reliability") rest[0] = "uptime";
  return <Navigate to={[parkPath(park), ...rest].join("/") + search} replace />;
}

/** The layout for a park URL. An old /<key>/<tab> URL matches the same
 *  two-segment routes (country "alton_towers", slug "queues"), names no park,
 *  and is redirected instead. */
function ParkGate() {
  return useParkKey() ? <Layout /> : <LegacyRedirect />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Park home: the rich merged calendar (hours + events + main + RAP). */}
        <Route path="/:country/:slug" element={<ParkGate />}>
          <Route index element={<ParkCalendarPage />} />
        </Route>
        {/* Ride queue times — today, and a specific past day. Static "queues"
            outranks the :product route below in React Router's matcher. */}
        <Route path="/:country/:slug/queues" element={<ParkGate />}>
          <Route index element={<QueuesPage />} />
        </Route>
        <Route path="/:country/:slug/queues/:date" element={<ParkGate />}>
          <Route index element={<QueuesPage />} />
        </Route>
        {/* How often each ride is actually running (stats/<park>/summary.json).
            Literal segment, so it outranks :product like the others. */}
        <Route path="/:country/:slug/uptime" element={<ParkGate />}>
          <Route index element={<UptimePage />} />
        </Route>
        {/* The tab was called Reliability before; keep those links working. */}
        <Route path="/:country/:slug/reliability" element={<RedirectToUptime />} />
        {/* Menus photographed in the park (contrib/menus → menus.generated.json).
            Another literal segment, so it outranks :product too. */}
        <Route path="/:country/:slug/food" element={<ParkGate />}>
          <Route index element={<MenusPage />} />
        </Route>
        {/* Static per-park link directory. Like "queues", the literal segment
            outranks the :product route below. */}
        <Route path="/:country/:slug/links" element={<ParkGate />}>
          <Route index element={<LinksPage />} />
        </Route>
        {/* Drill-down: the per-product availability heatmap. */}
        <Route path="/:country/:slug/:product" element={<ParkGate />}>
          <Route index element={<CalendarPage />} />
        </Route>
        <Route path="*" element={<LegacyRedirect />} />
      </Routes>
    </BrowserRouter>
  );
}
