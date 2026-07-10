import { Suspense } from "react";
import { DoctorCalendar } from "./doctor-calendar";

export default function DoctorCalendarPage() {
  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-4 text-xl font-semibold">Minha agenda</h1>
      <Suspense fallback={<p role="status">Carregando…</p>}>
        <DoctorCalendar />
      </Suspense>
    </main>
  );
}
