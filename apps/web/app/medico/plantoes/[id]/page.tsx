import { Suspense } from "react";
import { ShiftDetail } from "./shift-detail";

export default async function ShiftDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-2xl p-6">
      <Suspense fallback={<p role="status">Carregando…</p>}>
        <ShiftDetail shiftId={id} />
      </Suspense>
    </main>
  );
}
