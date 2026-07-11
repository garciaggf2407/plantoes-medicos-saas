import { Suspense } from "react";
import { ReviewQueue } from "./review-queue";

export default function AdminReviewPage() {
  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Fila de revisão</h1>
      <Suspense fallback={<p role="status">Carregando…</p>}>
        <ReviewQueue />
      </Suspense>
    </div>
  );
}
