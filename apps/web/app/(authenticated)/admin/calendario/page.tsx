import { Suspense } from "react";
import { AdminCalendar } from "./admin-calendar";
import { PageHeader } from "@/components/ui/page-header";
import { LoadingState } from "@/components/ui/loading-state";

export default function AdminCalendarPage() {
  return (
    <div>
      <PageHeader title="Calendário da unidade" description="Visão consolidada dos plantões publicados e preenchidos." />
      <Suspense fallback={<LoadingState />}>
        <AdminCalendar />
      </Suspense>
    </div>
  );
}
