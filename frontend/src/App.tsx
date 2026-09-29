import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { CalendarPage } from "./CalendarPage";
import { PARK_HOME } from "./catalog";
import { Layout } from "./Layout";
import { LinksPage } from "./LinksPage";
import { MenusPage } from "./MenusPage";
import { ParkCalendarPage } from "./ParkCalendarPage";
import { QueuesPage } from "./QueuesPage";
import { UptimePage } from "./UptimePage";

/** /:park/reliability → /:park/uptime, preserving the park. */
function RedirectToUptime() {
  const { park } = useParams();
  return <Navigate to={`/${park}/uptime`} replace />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Park home: the rich merged calendar (hours + events + main + RAP). */}
        <Route path="/:park" element={<Layout />}>
          <Route index element={<ParkCalendarPage />} />
        </Route>
        {/* Ride queue times — today, and a specific past day. Static "queues"
            outranks the :product route below in React Router's matcher. */}
        <Route path="/:park/queues" element={<Layout />}>
          <Route index element={<QueuesPage />} />
        </Route>
        <Route path="/:park/queues/:date" element={<Layout />}>
          <Route index element={<QueuesPage />} />
        </Route>
        {/* How often each ride is actually running (stats/<park>/summary.json).
            Literal segment, so it outranks :product like the others. */}
        <Route path="/:park/uptime" element={<Layout />}>
          <Route index element={<UptimePage />} />
        </Route>
        {/* The tab was called Reliability before; keep those links working. */}
        <Route path="/:park/reliability" element={<RedirectToUptime />} />
        {/* Menus photographed in the park (contrib/menus → menus.generated.json).
            Another literal segment, so it outranks :product too. */}
        <Route path="/:park/food" element={<Layout />}>
          <Route index element={<MenusPage />} />
        </Route>
        {/* Static per-park link directory. Like "queues", the literal segment
            outranks the :product route below. */}
        <Route path="/:park/links" element={<Layout />}>
          <Route index element={<LinksPage />} />
        </Route>
        {/* Drill-down: the per-product availability heatmap. */}
        <Route path="/:park/:product" element={<Layout />}>
          <Route index element={<CalendarPage />} />
        </Route>
        <Route path="*" element={<Navigate to={PARK_HOME} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
