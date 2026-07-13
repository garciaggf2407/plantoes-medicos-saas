import { Suspense } from "react";
import { ShiftListing } from "./shift-listing";
import { LoadingState } from "@/components/ui/loading-state";

// PageHeader mora dentro de ShiftListing (client component) porque a
// description passa a depender do hospital carregado na busca (T-2.2.1).
export default function DoctorShiftsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ShiftListing />
    </Suspense>
  );
}
