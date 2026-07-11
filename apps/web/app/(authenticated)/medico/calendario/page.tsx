import { Suspense } from "react";
import { DoctorCalendar } from "./doctor-calendar";
import { PageHeader } from "@/components/ui/page-header";
import { LoadingState } from "@/components/ui/loading-state";

export default function DoctorCalendarPage() {
  return (
    <div>
      <PageHeader title="Minha agenda" description="Seus plantões aprovados, em visão mensal ou semanal." />
      <Suspense fallback={<LoadingState />}>
        <DoctorCalendar />
      </Suspense>
    </div>
  );
}
