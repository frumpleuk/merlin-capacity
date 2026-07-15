import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { CalendarPage } from "./CalendarPage";
import { DEFAULT_PATH } from "./catalog";
import { Layout } from "./Layout";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/:park/:product" element={<Layout />}>
          <Route index element={<CalendarPage />} />
        </Route>
        <Route path="*" element={<Navigate to={DEFAULT_PATH} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
