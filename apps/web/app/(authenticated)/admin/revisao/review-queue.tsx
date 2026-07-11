"use client";

import { useEffect, useState } from "react";
import type { PendingCredentialDto, PendingApplicationDto } from "@plantoes/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";

function centsToReais(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

const ERROR_MESSAGES: Record<string, string> = {
  shift_already_filled: "Este plantão já foi aprovado para outro médico enquanto você decidia.",
};

type ItemState = { justification: string; submitting: boolean; error: string | null };

export function ReviewQueue() {
  const meState = useMe();
  const [credentials, setCredentials] = useState<PendingCredentialDto[] | null>(null);
  const [applications, setApplications] = useState<PendingApplicationDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [itemStates, setItemStates] = useState<Record<string, ItemState>>({});

  async function reload() {
    try {
      const [creds, apps] = await Promise.all([
        apiFetch<PendingCredentialDto[]>("/credentials/pending"),
        apiFetch<PendingApplicationDto[]>("/applications/pending"),
      ]);
      setCredentials(creds);
      setApplications(apps);
    } catch (err) {
      setLoadError(err instanceof ApiError ? `Não foi possível carregar a fila (erro ${err.status})` : "Não foi possível carregar a fila");
    }
  }

  useEffect(() => {
    if (meState.status === "ready") {
      void reload();
    }
  }, [meState.status]);

  function getItemState(id: string): ItemState {
    return itemStates[id] ?? { justification: "", submitting: false, error: null };
  }
  function setJustification(id: string, justification: string) {
    setItemStates((prev) => ({ ...prev, [id]: { ...getItemState(id), justification } }));
  }

  async function decide(kind: "credential" | "application", id: string, decision: "APPROVED" | "REJECTED", organizationId: string) {
    const current = getItemState(id);
    if (!current.justification.trim()) {
      setItemStates((prev) => ({ ...prev, [id]: { ...current, error: "Justificativa é obrigatória" } }));
      return;
    }
    setItemStates((prev) => ({ ...prev, [id]: { ...current, submitting: true, error: null } }));

    const path = kind === "credential" ? `/credentials/${id}/review` : `/applications/${id}/review`;
    try {
      await apiFetch(path, {
        method: "POST",
        body: JSON.stringify({ organizationId, decision, justification: current.justification.trim() }),
      });
      // Nunca otimista: a lista só reflete o que o servidor confirmar.
      await reload();
      setItemStates((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (err) {
      const message =
        err instanceof ApiError && err.body && typeof err.body === "object" && "reason" in err.body
          ? (ERROR_MESSAGES[(err.body as { reason: string }).reason] ?? "Não foi possível concluir a decisão")
          : "Não foi possível concluir a decisão";
      setItemStates((prev) => ({ ...prev, [id]: { ...getItemState(id), submitting: false, error: message } }));
      // Estado pode ter mudado (ex.: outro admin decidiu antes) — recarrega para refletir a realidade do servidor.
      await reload();
    }
  }

  if (meState.status === "loading") return <LoadingState />;
  if (meState.status === "error") return <ErrorState message="Não foi possível carregar seus dados." />;
  if (loadError) return <ErrorState message={loadError} />;

  const organizationId = meState.me.organizationId ?? "";

  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Credenciais pendentes</h2>
      {credentials === null ? (
        <LoadingState />
      ) : credentials.length === 0 ? (
        <div className="mb-6">
          <EmptyState message="Nenhuma credencial pendente." />
        </div>
      ) : (
        <ul className="mb-6 flex flex-col gap-3">
          {credentials.map((c) => {
            const state = getItemState(c.id);
            return (
              <li key={c.id}>
                <Card>
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge variant="neutral">Credencial</Badge>
                    <span className="text-sm font-medium text-slate-900">{c.doctorProfile.user.email}</span>
                  </div>
                  <div className="text-sm text-slate-600">
                    CRM {c.doctorProfile.crmNumber} · {c.doctorProfile.specialties.join(", ")}
                  </div>
                  <div className="text-xs text-slate-500">Enviado em {formatDateTime(c.createdAt)}</div>
                  <ReviewActions
                    state={state}
                    onJustificationChange={(v) => setJustification(c.id, v)}
                    onApprove={() => decide("credential", c.id, "APPROVED", organizationId)}
                    onReject={() => decide("credential", c.id, "REJECTED", organizationId)}
                  />
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="mb-3 text-sm font-semibold text-slate-900">Candidaturas pendentes</h2>
      {applications === null ? (
        <LoadingState />
      ) : applications.length === 0 ? (
        <EmptyState message="Nenhuma candidatura pendente." />
      ) : (
        <ul className="flex flex-col gap-3">
          {applications.map((a) => {
            const state = getItemState(a.id);
            return (
              <li key={a.id}>
                <Card>
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge variant="neutral">Candidatura</Badge>
                    <span className="text-sm font-medium text-slate-900">{a.doctorProfile.user.email}</span>
                  </div>
                  <div className="text-sm text-slate-600">CRM {a.doctorProfile.crmNumber}</div>
                  <div className="text-sm text-slate-600">
                    {a.shift.specialty} — {formatDateTime(a.shift.startsAt)} a {formatDateTime(a.shift.endsAt)} · {centsToReais(a.shift.valueCents)}
                  </div>
                  <ReviewActions
                    state={state}
                    onJustificationChange={(v) => setJustification(a.id, v)}
                    onApprove={() => decide("application", a.id, "APPROVED", organizationId)}
                    onReject={() => decide("application", a.id, "REJECTED", organizationId)}
                  />
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ReviewActions({
  state,
  onJustificationChange,
  onApprove,
  onReject,
}: {
  state: ItemState;
  onJustificationChange: (value: string) => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <label className="flex-1 text-sm">
        <span className="sr-only">Justificativa</span>
        <input
          type="text"
          required
          placeholder="Justificativa (obrigatória)"
          value={state.justification}
          onChange={(e) => onJustificationChange(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
        />
      </label>
      <Button type="button" size="sm" disabled={state.submitting} onClick={onApprove}>
        {state.submitting ? "Enviando…" : "Aprovar"}
      </Button>
      <Button type="button" size="sm" variant="danger" disabled={state.submitting} onClick={onReject}>
        Rejeitar
      </Button>
      {state.error && (
        <div className="w-full">
          <ErrorState message={state.error} />
        </div>
      )}
    </div>
  );
}
