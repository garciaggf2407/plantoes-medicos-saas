import { Suspense } from "react";
import { DoctorCalendar } from "./doctor-calendar";

export default function DoctorCalendarPage() {
  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Minha agenda</h1>
      <Suspense fallback={<p role="status">Carregando…</p>}>
        <DoctorCalendar />
      </Suspense>
    </div>
  );
}
