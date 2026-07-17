import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { CalendarPage } from "./CalendarPage";
import { PARK_HOME } from "./catalog";
import { Layout } from "./Layout";
import { ParkCalendarPage } from "./ParkCalendarPage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Park home: the rich merged calendar (hours + events + main + RAP). */}
        <Route path="/:park" element={<Layout />}>
          <Route index element={<ParkCalendarPage />} />
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
