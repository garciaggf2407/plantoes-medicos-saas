import { Suspense } from "react";
import { AdminShifts } from "./admin-shifts";
import { PageHeader } from "@/components/ui/page-header";
import { LoadingState } from "@/components/ui/loading-state";

export default function AdminShiftsPage() {
  return (
    <div>
      <PageHeader title="Gestão de plantões" description="Crie, publique, edite e cancele os plantões da sua unidade." />
      <Suspense fallback={<LoadingState />}>
        <AdminShifts />
      </Suspense>
    </div>
  );
}
