import { Suspense } from "react";
import { AdminCalendar } from "./admin-calendar";

export default function AdminCalendarPage() {
  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Calendário da unidade</h1>
      <Suspense fallback={<p role="status">Carregando…</p>}>
        <AdminCalendar />
      </Suspense>
    </div>
  );
}
