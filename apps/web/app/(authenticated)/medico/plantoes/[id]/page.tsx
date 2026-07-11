import { Suspense } from "react";
import { ShiftDetail } from "./shift-detail";
import { LoadingState } from "@/components/ui/loading-state";

export default async function ShiftDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <Suspense fallback={<LoadingState />}>
        <ShiftDetail shiftId={id} />
      </Suspense>
    </div>
  );
}
