import { Suspense } from "react";
import { ShiftDetail } from "./shift-detail";

export default async function ShiftDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <Suspense fallback={<p role="status">Carregando…</p>}>
        <ShiftDetail shiftId={id} />
      </Suspense>
    </div>
  );
}
