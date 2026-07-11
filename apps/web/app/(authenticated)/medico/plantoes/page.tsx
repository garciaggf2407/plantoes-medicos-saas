import { Suspense } from "react";
import { ShiftListing } from "./shift-listing";
import { PageHeader } from "@/components/ui/page-header";
import { LoadingState } from "@/components/ui/loading-state";

export default function DoctorShiftsPage() {
  return (
    <div>
      <PageHeader title="Plantões disponíveis" description="Filtre e candidate-se aos plantões abertos no seu hospital." />
      <Suspense fallback={<LoadingState />}>
        <ShiftListing />
      </Suspense>
    </div>
  );
}
