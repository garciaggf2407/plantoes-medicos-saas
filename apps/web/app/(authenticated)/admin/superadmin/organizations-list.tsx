"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { OrganizationSummaryDto } from "@plantoes/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; organizations: OrganizationSummaryDto[] };

export function OrganizationsList() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    apiFetch<OrganizationSummaryDto[]>("/organizations")
      .then((organizations) => setState({ status: "ready", organizations }))
      .catch((err: unknown) => {
        const message =
          err instanceof ApiError
            ? `Não foi possível carregar os hospitais (erro ${err.status})`
            : "Não foi possível carregar os hospitais";
        setState({ status: "error", message });
      });
  }, []);

  if (state.status === "loading") {
    return <LoadingState message="Carregando hospitais…" />;
  }
  if (state.status === "error") {
    return <ErrorState message={state.message} />;
  }
  if (state.organizations.length === 0) {
    return <EmptyState message="Nenhum hospital provisionado ainda." />;
  }

  return (
    <ul className="flex flex-col gap-3">
      {state.organizations.map((organization) => (
        <li key={organization.id}>
          <Link href={`/admin/superadmin/${organization.id}`} className="block">
            <Card className="transition-colors hover:bg-background">
              <div className="font-medium text-label">{organization.name}</div>
              <div className="text-sm text-label-secondary">
                {[organization.city, organization.address].filter(Boolean).join(" — ") || "Endereço não cadastrado"}
              </div>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}
