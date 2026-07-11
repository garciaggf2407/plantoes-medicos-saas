import { Suspense } from "react";
import { AdminShifts } from "./admin-shifts";

export default function AdminShiftsPage() {
  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Gestão de plantões</h1>
      <Suspense fallback={<p role="status">Carregando…</p>}>
        <AdminShifts />
      </Suspense>
    </div>
  );
}
