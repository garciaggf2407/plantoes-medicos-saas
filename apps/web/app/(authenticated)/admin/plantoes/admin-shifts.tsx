"use client";

import { useEffect, useState } from "react";
import type { AdminShiftDto } from "@plantoes/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import { Card } from "@/components/ui/card";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Rascunho",
  PUBLISHED: "Publicado",
  FILLED: "Preenchido",
  CANCELLED: "Cancelado",
};

const STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: "neutral",
  PUBLISHED: "pending",
  FILLED: "positive",
  CANCELLED: "negative",
};

const INPUT_CLASS =
  "rounded-control border border-separator px-2.5 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

function centsToReais(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function toDateTimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function localValueToIsoUtc(value: string): string {
  return `${value}:00Z`;
}

interface CreateFormState {
  specialty: string;
  valueReais: string;
  startsAt: string;
  endsAt: string;
}

export function AdminShifts() {
  const meState = useMe();
  const [shifts, setShifts] = useState<AdminShiftDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingCancelId, setConfirmingCancelId] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<CreateFormState>({ specialty: "", valueReais: "", startsAt: "", endsAt: "" });
  const [formError, setFormError] = useState<string | null>(null);

  async function reload() {
    try {
      const data = await apiFetch<AdminShiftDto[]>("/shifts");
      setShifts(data);
    } catch (err) {
      setError(err instanceof ApiError ? `Não foi possível carregar os plantões (erro ${err.status})` : "Não foi possível carregar os plantões");
    }
  }

  useEffect(() => {
    if (meState.status === "ready") {
      void reload();
    }
  }, [meState.status]);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    // Validação client-side é só conveniência de UX — a API sempre
    // revalida tudo de novo no servidor (centavos, ISO UTC, etc.).
    if (!createForm.specialty.trim()) {
      setFormError("Especialidade é obrigatória");
      return;
    }
    const valueCents = Math.round(Number(createForm.valueReais) * 100);
    if (!Number.isFinite(valueCents) || valueCents <= 0) {
      setFormError("Valor deve ser positivo");
      return;
    }
    try {
      await apiFetch("/shifts", {
        method: "POST",
        body: JSON.stringify({
          specialty: createForm.specialty.trim(),
          valueCents,
          startsAt: localValueToIsoUtc(createForm.startsAt),
          endsAt: localValueToIsoUtc(createForm.endsAt),
        }),
      });
      setCreateForm({ specialty: "", valueReais: "", startsAt: "", endsAt: "" });
      await reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? "O servidor rejeitou os dados informados" : "Erro ao criar plantão");
    }
  }

  async function handlePublish(id: string) {
    await apiFetch(`/shifts/${id}/publish`, { method: "POST" });
    await reload();
  }

  async function handleCancelConfirmed(id: string) {
    await apiFetch(`/shifts/${id}/cancel`, { method: "POST" });
    setConfirmingCancelId(null);
    await reload();
  }

  async function handleSaveEdit(id: string, form: CreateFormState) {
    await apiFetch(`/shifts/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        specialty: form.specialty.trim(),
        valueCents: Math.round(Number(form.valueReais) * 100),
        startsAt: localValueToIsoUtc(form.startsAt),
        endsAt: localValueToIsoUtc(form.endsAt),
      }),
    });
    setEditingId(null);
    await reload();
  }

  if (meState.status === "loading") return <LoadingState />;
  if (meState.status === "error") return <ErrorState message="Não foi possível carregar seus dados." />;

  return (
    <div>
      <Card className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-label">Novo plantão</h2>
        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-label-secondary">
            Especialidade
            <input
              required
              type="text"
              value={createForm.specialty}
              onChange={(e) => setCreateForm({ ...createForm, specialty: e.target.value })}
              className={INPUT_CLASS}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-label-secondary">
            Valor (R$)
            <input
              required
              type="number"
              min="0.01"
              step="0.01"
              value={createForm.valueReais}
              onChange={(e) => setCreateForm({ ...createForm, valueReais: e.target.value })}
              className={INPUT_CLASS}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-label-secondary">
            Início
            <input
              required
              type="datetime-local"
              value={createForm.startsAt}
              onChange={(e) => setCreateForm({ ...createForm, startsAt: e.target.value })}
              className={INPUT_CLASS}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-label-secondary">
            Fim
            <input
              required
              type="datetime-local"
              value={createForm.endsAt}
              onChange={(e) => setCreateForm({ ...createForm, endsAt: e.target.value })}
              className={INPUT_CLASS}
            />
          </label>
          <Button type="submit" size="sm">
            Criar (rascunho)
          </Button>
        </form>
        {formError && (
          <div className="mt-3">
            <ErrorState message={formError} />
          </div>
        )}
      </Card>

      {error && <ErrorState message={error} />}
      {!error && shifts === null && <LoadingState message="Carregando plantões…" />}
      {!error && shifts !== null && shifts.length === 0 && <EmptyState message="Nenhum plantão cadastrado ainda." />}
      {!error && shifts !== null && shifts.length > 0 && (
        <div className="overflow-x-auto rounded-card bg-surface shadow-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-separator text-left">
                <th scope="col" className="px-3 py-2 font-medium text-label-secondary">Especialidade</th>
                <th scope="col" className="px-3 py-2 font-medium text-label-secondary">Início</th>
                <th scope="col" className="px-3 py-2 font-medium text-label-secondary">Fim</th>
                <th scope="col" className="px-3 py-2 font-medium text-label-secondary">Valor</th>
                <th scope="col" className="px-3 py-2 font-medium text-label-secondary">Status</th>
                <th scope="col" className="px-3 py-2 font-medium text-label-secondary">Ações</th>
              </tr>
            </thead>
            <tbody>
              {shifts.map((shift) =>
                editingId === shift.id ? (
                  <EditRow key={shift.id} shift={shift} onCancel={() => setEditingId(null)} onSave={(form) => handleSaveEdit(shift.id, form)} />
                ) : (
                  <tr key={shift.id} className="border-b border-separator last:border-0">
                    <td className="px-3 py-2 text-label">{shift.specialty}</td>
                    <td className="px-3 py-2 text-label-secondary">{new Date(shift.startsAt).toLocaleString("pt-BR")}</td>
                    <td className="px-3 py-2 text-label-secondary">{new Date(shift.endsAt).toLocaleString("pt-BR")}</td>
                    <td className="px-3 py-2 text-label">{centsToReais(shift.valueCents)}</td>
                    <td className="px-3 py-2">
                      <Badge variant={STATUS_BADGE[shift.status] ?? "neutral"}>{STATUS_LABEL[shift.status] ?? shift.status}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-2">
                        {shift.status === "DRAFT" && (
                          <Button type="button" size="sm" variant="secondary" onClick={() => handlePublish(shift.id)}>
                            Publicar
                          </Button>
                        )}
                        {(shift.status === "DRAFT" || shift.status === "PUBLISHED") && (
                          <Button type="button" size="sm" variant="secondary" onClick={() => setEditingId(shift.id)}>
                            Editar
                          </Button>
                        )}
                        {(shift.status === "DRAFT" || shift.status === "PUBLISHED") &&
                          (confirmingCancelId === shift.id ? (
                            <span className="flex gap-2">
                              <Button type="button" size="sm" variant="danger" onClick={() => handleCancelConfirmed(shift.id)}>
                                Confirmar cancelamento
                              </Button>
                              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmingCancelId(null)}>
                                Voltar
                              </Button>
                            </span>
                          ) : (
                            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmingCancelId(shift.id)}>
                              Cancelar
                            </Button>
                          ))}
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EditRow({
  shift,
  onCancel,
  onSave,
}: {
  shift: AdminShiftDto;
  onCancel: () => void;
  onSave: (form: CreateFormState) => void;
}) {
  const [form, setForm] = useState<CreateFormState>({
    specialty: shift.specialty,
    valueReais: (shift.valueCents / 100).toFixed(2),
    startsAt: toDateTimeLocalValue(shift.startsAt),
    endsAt: toDateTimeLocalValue(shift.endsAt),
  });

  return (
    <tr className="border-b border-separator bg-background last:border-0">
      <td className="px-3 py-2">
        <input value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} className={`w-full ${INPUT_CLASS}`} />
      </td>
      <td className="px-3 py-2">
        <input type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} className={INPUT_CLASS} />
      </td>
      <td className="px-3 py-2">
        <input type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} className={INPUT_CLASS} />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          step="0.01"
          value={form.valueReais}
          onChange={(e) => setForm({ ...form, valueReais: e.target.value })}
          className={`w-20 ${INPUT_CLASS}`}
        />
      </td>
      <td className="px-3 py-2">
        <Badge variant={STATUS_BADGE[shift.status] ?? "neutral"}>{STATUS_LABEL[shift.status] ?? shift.status}</Badge>
      </td>
      <td className="px-3 py-2">
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={() => onSave(form)}>
            Salvar
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </td>
    </tr>
  );
}
