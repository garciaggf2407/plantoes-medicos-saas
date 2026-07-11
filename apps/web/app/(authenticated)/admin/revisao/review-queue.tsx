"use client";

import { useEffect, useState } from "react";
import type { PendingCredentialDto, PendingApplicationDto } from "@plantoes/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { useMe } from "@/lib/use-me";

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

  if (meState.status === "loading") return <p role="status">Carregando…</p>;
  if (meState.status === "error") return <p role="alert" className="text-red-600">Não foi possível carregar seus dados.</p>;
  if (loadError) return <p role="alert" className="text-red-600">{loadError}</p>;

  const organizationId = meState.me.organizationId ?? "";

  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold">Credenciais pendentes</h2>
      {credentials === null ? (
        <p role="status">Carregando…</p>
      ) : credentials.length === 0 ? (
        <p role="status" className="mb-6">Nenhuma credencial pendente.</p>
      ) : (
        <ul className="mb-6 flex flex-col gap-3">
          {credentials.map((c) => {
            const state = getItemState(c.id);
            return (
              <li key={c.id} className="rounded border p-3">
                <div className="text-sm">
                  <span className="font-medium">{c.doctorProfile.user.email}</span> · CRM {c.doctorProfile.crmNumber} ·{" "}
                  {c.doctorProfile.specialties.join(", ")}
                </div>
                <div className="text-xs text-gray-500">Enviado em {formatDateTime(c.createdAt)}</div>
                <ReviewActions
                  state={state}
                  onJustificationChange={(v) => setJustification(c.id, v)}
                  onApprove={() => decide("credential", c.id, "APPROVED", organizationId)}
                  onReject={() => decide("credential", c.id, "REJECTED", organizationId)}
                />
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="mb-2 text-sm font-semibold">Candidaturas pendentes</h2>
      {applications === null ? (
        <p role="status">Carregando…</p>
      ) : applications.length === 0 ? (
        <p role="status">Nenhuma candidatura pendente.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {applications.map((a) => {
            const state = getItemState(a.id);
            return (
              <li key={a.id} className="rounded border p-3">
                <div className="text-sm">
                  <span className="font-medium">{a.doctorProfile.user.email}</span> · CRM {a.doctorProfile.crmNumber}
                </div>
                <div className="text-sm">
                  {a.shift.specialty} — {formatDateTime(a.shift.startsAt)} a {formatDateTime(a.shift.endsAt)} · {centsToReais(a.shift.valueCents)}
                </div>
                <ReviewActions
                  state={state}
                  onJustificationChange={(v) => setJustification(a.id, v)}
                  onApprove={() => decide("application", a.id, "APPROVED", organizationId)}
                  onReject={() => decide("application", a.id, "REJECTED", organizationId)}
                />
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
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <label className="flex-1 text-sm">
        <span className="sr-only">Justificativa</span>
        <input
          type="text"
          required
          placeholder="Justificativa (obrigatória)"
          value={state.justification}
          onChange={(e) => onJustificationChange(e.target.value)}
          className="w-full rounded border px-2 py-1"
        />
      </label>
      <button type="button" disabled={state.submitting} onClick={onApprove} className="rounded bg-black px-3 py-1 text-white disabled:opacity-50">
        {state.submitting ? "Enviando…" : "Aprovar"}
      </button>
      <button
        type="button"
        disabled={state.submitting}
        onClick={onReject}
        className="rounded border border-red-600 px-3 py-1 text-red-600 disabled:opacity-50"
      >
        Rejeitar
      </button>
      {state.error && (
        <p role="alert" className="w-full text-sm text-red-600">
          {state.error}
        </p>
      )}
    </div>
  );
}
