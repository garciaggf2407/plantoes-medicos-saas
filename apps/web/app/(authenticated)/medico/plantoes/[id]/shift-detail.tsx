"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { ShiftHospitalDto, ShiftSummary } from "@plantoes/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { LoadingState } from "@/components/ui/loading-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";

function centsToReais(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

/** Mensagens amigáveis por motivo de rejeição — nunca expor detalhe interno/stack. */
const REJECTION_MESSAGES: Record<string, string> = {
  credential_not_approved: "Sua credencial para este hospital ainda não foi aprovada.",
  specialty_mismatch: "Sua especialidade cadastrada não é compatível com este plantão.",
  shift_not_published: "Este plantão não está mais disponível.",
  schedule_conflict: "Você já tem outro plantão aprovado que conflita com este horário.",
};

type ViewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; shift: ShiftSummary }
  | { status: "not-found" };

type SubmitState = "idle" | "confirming" | "submitting" | "success" | { error: string };

export function ShiftDetail({ shiftId }: { shiftId: string }) {
  const searchParams = useSearchParams();
  const organizationId = searchParams.get("organizationId") ?? "";

  const [view, setView] = useState<ViewState>({ status: "loading" });
  const [submit, setSubmit] = useState<SubmitState>("idle");
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!organizationId) {
      return;
    }
    apiFetch<ShiftSummary>(`/shifts/${shiftId}?organizationId=${organizationId}`)
      .then((shift) => setView({ status: "ready", shift }))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          setView({ status: "not-found" });
        } else {
          setView({ status: "error", message: "Não foi possível carregar o plantão." });
        }
      });
  }, [shiftId, organizationId]);

  useEffect(() => {
    if (submit === "success" || (typeof submit === "object" && submit.error)) {
      resultRef.current?.focus();
    }
  }, [submit]);

  async function confirmApplication() {
    setSubmit("submitting");
    try {
      await apiFetch(`/applications`, {
        method: "POST",
        body: JSON.stringify({ shiftId, organizationId }),
      });
      setSubmit("success");
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && isRejectionBody(err.body)) {
        setSubmit({ error: REJECTION_MESSAGES[err.body.reason] ?? "Não foi possível concluir a candidatura." });
      } else {
        setSubmit({ error: "Não foi possível concluir a candidatura. Tente novamente." });
      }
    }
  }

  const backLink = (
    <Link
      href={`/medico/plantoes?organizationId=${organizationId}`}
      className="mb-4 inline-block text-sm text-label-secondary hover:text-label"
    >
      ← Voltar à listagem
    </Link>
  );

  if (!organizationId) {
    return <EmptyState message="Hospital não informado na URL." />;
  }
  if (view.status === "loading") {
    return <LoadingState />;
  }
  if (view.status === "not-found") {
    return (
      <div>
        {backLink}
        <EmptyState message="Plantão não encontrado." />
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

  const { shift } = view;

  return (
    <div>
      {backLink}
      <PageHeader title={shift.specialty} description="Confirme os detalhes antes de se candidatar." />
      <Card className="mb-6">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="font-medium text-label-secondary">Início</dt>
          <dd className="text-label">{formatDateTime(shift.startsAt)}</dd>
          <dt className="font-medium text-label-secondary">Fim</dt>
          <dd className="text-label">{formatDateTime(shift.endsAt)}</dd>
          <dt className="font-medium text-label-secondary">Valor</dt>
          <dd className="text-label">{centsToReais(shift.valueCents)}</dd>
        </dl>
      </Card>

      <HospitalCard hospital={shift.hospital} />

      {submit === "success" ? (
        <div
          ref={resultRef}
          tabIndex={-1}
          role="status"
          className="rounded-card bg-positive-bg px-4 py-3 text-sm text-positive"
        >
          Candidatura enviada com sucesso! Aguarde a decisão do hospital.
        </div>
      ) : typeof submit === "object" && submit.error ? (
        <div ref={resultRef} tabIndex={-1}>
          <ErrorState message={submit.error} />
        </div>
      ) : submit === "confirming" ? (
        <div className="flex gap-3">
          <Button type="button" onClick={confirmApplication}>
            Confirmar candidatura
          </Button>
          <Button type="button" variant="secondary" onClick={() => setSubmit("idle")}>
            Cancelar
          </Button>
        </div>
      ) : (
        <Button type="button" onClick={() => setSubmit("confirming")} disabled={submit === "submitting"}>
          {submit === "submitting" ? "Enviando…" : "Candidatar-se"}
        </Button>
      )}
    </div>
  );
}

function isRejectionBody(body: unknown): body is { reason: string } {
  return typeof body === "object" && body !== null && "reason" in body && typeof (body as { reason: unknown }).reason === "string";
}

/** Só renderiza se ao menos um dos campos de perfil do hospital estiver presente -- nunca um card vazio. */
function HospitalCard({ hospital }: { hospital: ShiftHospitalDto }) {
  const location = hospital.address ?? hospital.city;
  const hasContent = Boolean(location || hospital.description || hospital.photoUrl);
  if (!hasContent) {
    return null;
  }

  return (
    <Card className="mb-6">
      <h2 className="text-base font-semibold text-label">Sobre o hospital</h2>
      <p className="text-sm text-label">{hospital.name}</p>
      {location && <p className="mt-1 text-sm text-label-secondary">{location}</p>}
      {hospital.description && <p className="mt-2 text-sm text-label-secondary">{hospital.description}</p>}
      {hospital.photoUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- perfil simples, sem otimização de imagem necessária
        <img src={hospital.photoUrl} alt={hospital.name} className="mt-3 max-h-48 w-full rounded-control object-cover" />
      )}
    </Card>
  );
}
