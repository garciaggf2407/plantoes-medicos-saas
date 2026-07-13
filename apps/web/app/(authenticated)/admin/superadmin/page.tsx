import { Suspense } from "react";
import { OrganizationsList } from "./organizations-list";
import { PageHeader } from "@/components/ui/page-header";
import { LoadingState } from "@/components/ui/loading-state";

export default function SuperadminOrganizationsPage() {
  return (
    <div>
      <PageHeader title="Todos os hospitais" description="Visibilidade operacional de qualquer hospital da plataforma (só leitura)." />
      <Suspense fallback={<LoadingState />}>
        <OrganizationsList />
      </Suspense>
    </div>
  );
}
