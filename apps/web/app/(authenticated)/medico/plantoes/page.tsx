import { Suspense } from "react";
import { ShiftListing } from "./shift-listing";

export default function DoctorShiftsPage() {
  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Plantões disponíveis</h1>
      <Suspense fallback={<p role="status">Carregando…</p>}>
        <ShiftListing />
      </Suspense>
    </div>
  );
}
