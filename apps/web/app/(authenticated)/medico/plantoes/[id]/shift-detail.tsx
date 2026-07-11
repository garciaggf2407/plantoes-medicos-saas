"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { ShiftSummary } from "@plantoes/shared";
import { apiFetch, ApiError } from "@/lib/api";

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

  if (!organizationId) {
    return <p role="status">Hospital não informado na URL.</p>;
  }
  if (view.status === "loading") {
    return <p role="status">Carregando…</p>;
  }
  if (view.status === "not-found") {
    return <p role="status">Plantão não encontrado.</p>;
  }
  if (view.status === "error") {
    return (
      <p role="alert" className="text-red-600">
        {view.message}
      </p>
    );
  }

  const { shift } = view;

  return (
    <div>
      <Link href={`/medico/plantoes?organizationId=${organizationId}`} className="mb-4 inline-block underline">
        ← Voltar à listagem
      </Link>
      <h1 className="mb-2 text-xl font-semibold">{shift.specialty}</h1>
      <dl className="mb-6 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="font-medium">Início</dt>
        <dd>{formatDateTime(shift.startsAt)}</dd>
        <dt className="font-medium">Fim</dt>
        <dd>{formatDateTime(shift.endsAt)}</dd>
        <dt className="font-medium">Valor</dt>
        <dd>{centsToReais(shift.valueCents)}</dd>
      </dl>

      {submit === "success" ? (
        <div ref={resultRef} tabIndex={-1} role="status" className="rounded border border-green-600 p-3 text-green-700">
          Candidatura enviada com sucesso! Aguarde a decisão do hospital.
        </div>
      ) : typeof submit === "object" && submit.error ? (
        <div ref={resultRef} tabIndex={-1} role="alert" className="rounded border border-red-600 p-3 text-red-700">
          {submit.error}
        </div>
      ) : submit === "confirming" ? (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={confirmApplication}
            className="rounded bg-black px-4 py-2 text-white"
          >
            Confirmar candidatura
          </button>
          <button type="button" onClick={() => setSubmit("idle")} className="rounded border px-4 py-2">
            Cancelar
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setSubmit("confirming")}
          disabled={submit === "submitting"}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {submit === "submitting" ? "Enviando…" : "Candidatar-se"}
        </button>
      )}
    </div>
  );
}

function isRejectionBody(body: unknown): body is { reason: string } {
  return typeof body === "object" && body !== null && "reason" in body && typeof (body as { reason: unknown }).reason === "string";
}
