import { Suspense } from "react";
import { ReviewQueue } from "./review-queue";

export default function AdminReviewPage() {
  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-4 text-xl font-semibold">Fila de revisão</h1>
      <Suspense fallback={<p role="status">Carregando…</p>}>
        <ReviewQueue />
      </Suspense>
    </main>
  );
}
