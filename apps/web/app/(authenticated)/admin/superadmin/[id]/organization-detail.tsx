"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { OrganizationDetailDto } from "@plantoes/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { LoadingState } from "@/components/ui/loading-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";

const SHIFT_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Rascunho",
  PUBLISHED: "Publicado",
  FILLED: "Preenchido",
  CANCELLED: "Cancelado",
};

const SHIFT_STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: "neutral",
  PUBLISHED: "pending",
  FILLED: "positive",
  CANCELLED: "negative",
};

const DECISION_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendente",
  APPROVED: "Aprovada",
  REJECTED: "Rejeitada",
  EXPIRED: "Expirada",
};

const DECISION_STATUS_BADGE: Record<string, BadgeVariant> = {
  PENDING: "pending",
  APPROVED: "positive",
  REJECTED: "negative",
  EXPIRED: "neutral",
};

type ViewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "not-found" }
  | { status: "ready"; organization: OrganizationDetailDto };

function centsToReais(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

/**
 * Detalhe operacional de UM hospital para o SUPERADMIN -- SÓ LEITURA
 * (E-2, T-2.2.2). Nenhum botão/form de edição, aprovação ou
 * cancelamento existe nesta tela: o SUPERADMIN nunca age em nome de
 * um hospital, só observa.
 */
export function OrganizationDetail({ organizationId }: { organizationId: string }) {
  const [view, setView] = useState<ViewState>({ status: "loading" });

  useEffect(() => {
    apiFetch<OrganizationDetailDto>(`/organizations/${organizationId}/detail`)
      .then((organization) => setView({ status: "ready", organization }))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          setView({ status: "not-found" });
        } else {
          setView({ status: "error", message: "Não foi possível carregar o hospital." });
        }
      });
  }, [organizationId]);

  const backLink = (
    <Link href="/admin/superadmin" className="mb-4 inline-block text-sm text-label-secondary hover:text-label">
      ← Voltar a todos os hospitais
    </Link>
  );

  if (view.status === "loading") {
    return <LoadingState />;
  }
  if (view.status === "not-found") {
    return (
      <div>
        {backLink}
        <EmptyState message="Hospital não encontrado." />
      </div>
    );
  }
  if (view.status === "error") {
    return (
      <div>
        {backLink}
        <ErrorState message={view.message} />
      </div>
    );
  }

  const { organization } = view;

  return (
    <div>
      {backLink}
      <PageHeader title={organization.name} description="Visão operacional só leitura -- nenhuma ação de edição disponível nesta tela." />

      <Card className="mb-6">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="font-medium text-label-secondary">Fuso horário</dt>
          <dd className="text-label">{organization.timezone}</dd>
          <dt className="font-medium text-label-secondary">Cidade</dt>
          <dd className="text-label">{organization.city ?? "Não informado"}</dd>
          <dt className="font-medium text-label-secondary">Endereço</dt>
          <dd className="text-label">{organization.address ?? "Não informado"}</dd>
          {organization.description && (
            <>
              <dt className="font-medium text-label-secondary">Descrição</dt>
              <dd className="text-label">{organization.description}</dd>
            </>
          )}
        </dl>
      </Card>

      <h2 className="mb-3 text-sm font-semibold text-label">Plantões ({organization.shifts.length})</h2>
      {organization.shifts.length === 0 ? (
        <div className="mb-6">
          <EmptyState message="Nenhum plantão cadastrado." />
        </div>
      ) : (
        <div className="mb-6 overflow-x-auto rounded-card bg-surface shadow-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-separator text-left">
                <th scope="col" className="px-3 py-2 font-medium text-label-secondary">Especialidade</th>
                <th scope="col" className="px-3 py-2 font-medium text-label-secondary">Início</th>
                <th scope="col" className="px-3 py-2 font-medium text-label-secondary">Fim</th>
                <th scope="col" className="px-3 py-2 font-medium text-label-secondary">Valor</th>
                <th scope="col" className="px-3 py-2 font-medium text-label-secondary">Status</th>
              </tr>
            </thead>
            <tbody>
              {organization.shifts.map((shift) => (
                <tr key={shift.id} className="border-b border-separator last:border-0">
                  <td className="px-3 py-2 text-label">{shift.specialty}</td>
                  <td className="px-3 py-2 text-label-secondary">{formatDateTime(shift.startsAt)}</td>
                  <td className="px-3 py-2 text-label-secondary">{formatDateTime(shift.endsAt)}</td>
                  <td className="px-3 py-2 text-label">{centsToReais(shift.valueCents)}</td>
                  <td className="px-3 py-2">
                    <Badge variant={SHIFT_STATUS_BADGE[shift.status] ?? "neutral"}>
                      {SHIFT_STATUS_LABEL[shift.status] ?? shift.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold text-label">Candidaturas ({organization.applications.length})</h2>
      {organization.applications.length === 0 ? (
        <div className="mb-6">
          <EmptyState message="Nenhuma candidatura registrada." />
        </div>
      ) : (
        <ul className="mb-6 flex flex-col gap-3">
          {organization.applications.map((application) => (
            <li key={application.id}>
              <Card>
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge variant={DECISION_STATUS_BADGE[application.status] ?? "neutral"}>
                    {DECISION_STATUS_LABEL[application.status] ?? application.status}
                  </Badge>
                  <span className="text-sm font-medium text-label">{application.doctorProfile.user.email}</span>
                </div>
                <div className="text-sm text-label-secondary">
                  CRM {application.doctorProfile.crmNumber} · {application.doctorProfile.specialties.join(", ")}
                </div>
                <div className="text-sm text-label-secondary">
                  {application.shift.specialty} — {formatDateTime(application.shift.startsAt)} a {formatDateTime(application.shift.endsAt)} ·{" "}
                  {centsToReais(application.shift.valueCents)}
                </div>
                <div className="text-xs text-label-tertiary">Candidatura em {formatDateTime(application.appliedAt)}</div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mb-3 text-sm font-semibold text-label">Credenciais ({organization.credentials.length})</h2>
      {organization.credentials.length === 0 ? (
        <EmptyState message="Nenhuma credencial registrada." />
      ) : (
        <ul className="flex flex-col gap-3">
          {organization.credentials.map((credential) => (
            <li key={credential.id}>
              <Card>
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge variant={DECISION_STATUS_BADGE[credential.status] ?? "neutral"}>
                    {DECISION_STATUS_LABEL[credential.status] ?? credential.status}
                  </Badge>
                  <span className="text-sm font-medium text-label">{credential.doctorProfile.user.email}</span>
                </div>
                <div className="text-sm text-label-secondary">
                  CRM {credential.doctorProfile.crmNumber} · {credential.doctorProfile.specialties.join(", ")}
                </div>
                <div className="text-xs text-label-tertiary">Enviada em {formatDateTime(credential.createdAt)}</div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
