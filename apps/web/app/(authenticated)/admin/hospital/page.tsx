import { Suspense } from "react";
import { HospitalProfileForm } from "./hospital-profile-form";
import { PageHeader } from "@/components/ui/page-header";
import { LoadingState } from "@/components/ui/loading-state";

export default function HospitalProfilePage() {
  return (
    <div>
      <PageHeader title="Perfil do hospital" description="Atualize as informações públicas exibidas aos médicos." />
      <Suspense fallback={<LoadingState />}>
        <HospitalProfileForm />
      </Suspense>
    </div>
  );
}
