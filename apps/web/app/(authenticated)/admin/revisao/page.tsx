import { Suspense } from "react";
import { ReviewQueue } from "./review-queue";
import { PageHeader } from "@/components/ui/page-header";
import { LoadingState } from "@/components/ui/loading-state";

export default function AdminReviewPage() {
  return (
    <div>
      <PageHeader title="Fila de revisão" description="Aprove ou rejeite credenciais e candidaturas pendentes." />
      <Suspense fallback={<LoadingState />}>
        <ReviewQueue />
      </Suspense>
    </div>
  );
}
