import { Suspense } from "react";
import { OrganizationDetail } from "./organization-detail";
import { LoadingState } from "@/components/ui/loading-state";

export default async function SuperadminOrganizationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <Suspense fallback={<LoadingState />}>
        <OrganizationDetail organizationId={id} />
      </Suspense>
    </div>
  );
}
