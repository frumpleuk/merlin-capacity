import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { CalendarPage } from "./CalendarPage";
import { PARK_HOME } from "./catalog";
import { Layout } from "./Layout";
import { ParkCalendarPage } from "./ParkCalendarPage";
import { QueuesPage } from "./QueuesPage";

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
        {/* Drill-down: the per-product availability heatmap. */}
        <Route path="/:park/:product" element={<Layout />}>
          <Route index element={<CalendarPage />} />
        </Route>
        <Route path="*" element={<Navigate to={PARK_HOME} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
