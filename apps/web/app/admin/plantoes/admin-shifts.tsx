"use client";

import { useEffect, useState } from "react";
import type { AdminShiftDto } from "@plantoes/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import { ActiveHospitalBanner } from "@/components/active-hospital-banner";

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Rascunho",
  PUBLISHED: "Publicado",
  FILLED: "Preenchido",
  CANCELLED: "Cancelado",
};

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

  if (meState.status === "loading") return <p role="status">Carregando…</p>;
  if (meState.status === "error") return <p role="alert" className="text-red-600">Não foi possível carregar seus dados.</p>;

  return (
    <div>
      <ActiveHospitalBanner me={meState.me} />

      <h2 className="mb-2 text-sm font-semibold">Novo plantão</h2>
      <form onSubmit={handleCreate} className="mb-6 flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-sm">
          Especialidade
          <input
            required
            type="text"
            value={createForm.specialty}
            onChange={(e) => setCreateForm({ ...createForm, specialty: e.target.value })}
            className="rounded border px-2 py-1"
          />
        </label>
        <label className="flex flex-col text-sm">
          Valor (R$)
          <input
            required
            type="number"
            min="0.01"
            step="0.01"
            value={createForm.valueReais}
            onChange={(e) => setCreateForm({ ...createForm, valueReais: e.target.value })}
            className="rounded border px-2 py-1"
          />
        </label>
        <label className="flex flex-col text-sm">
          Início
          <input
            required
            type="datetime-local"
            value={createForm.startsAt}
            onChange={(e) => setCreateForm({ ...createForm, startsAt: e.target.value })}
            className="rounded border px-2 py-1"
          />
        </label>
        <label className="flex flex-col text-sm">
          Fim
          <input
            required
            type="datetime-local"
            value={createForm.endsAt}
            onChange={(e) => setCreateForm({ ...createForm, endsAt: e.target.value })}
            className="rounded border px-2 py-1"
          />
        </label>
        <button type="submit" className="rounded bg-black px-3 py-1 text-white">
          Criar (rascunho)
        </button>
      </form>
      {formError && <p role="alert" className="mb-4 text-red-600">{formError}</p>}

      {error && <p role="alert" className="text-red-600">{error}</p>}
      {!error && shifts === null && <p role="status">Carregando plantões…</p>}
      {!error && shifts !== null && shifts.length === 0 && <p role="status">Nenhum plantão cadastrado ainda.</p>}
      {!error && shifts !== null && shifts.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="py-1 pr-3">Especialidade</th>
              <th scope="col" className="py-1 pr-3">Início</th>
              <th scope="col" className="py-1 pr-3">Fim</th>
              <th scope="col" className="py-1 pr-3">Valor</th>
              <th scope="col" className="py-1 pr-3">Status</th>
              <th scope="col" className="py-1">Ações</th>
            </tr>
          </thead>
          <tbody>
            {shifts.map((shift) =>
              editingId === shift.id ? (
                <EditRow key={shift.id} shift={shift} onCancel={() => setEditingId(null)} onSave={(form) => handleSaveEdit(shift.id, form)} />
              ) : (
                <tr key={shift.id} className="border-b">
                  <td className="py-1 pr-3">{shift.specialty}</td>
                  <td className="py-1 pr-3">{new Date(shift.startsAt).toLocaleString("pt-BR")}</td>
                  <td className="py-1 pr-3">{new Date(shift.endsAt).toLocaleString("pt-BR")}</td>
                  <td className="py-1 pr-3">{centsToReais(shift.valueCents)}</td>
                  <td className="py-1 pr-3">{STATUS_LABEL[shift.status] ?? shift.status}</td>
                  <td className="py-1">
                    <div className="flex flex-wrap gap-2">
                      {shift.status === "DRAFT" && (
                        <button type="button" onClick={() => handlePublish(shift.id)} className="rounded border px-2 py-0.5">
                          Publicar
                        </button>
                      )}
                      {(shift.status === "DRAFT" || shift.status === "PUBLISHED") && (
                        <button type="button" onClick={() => setEditingId(shift.id)} className="rounded border px-2 py-0.5">
                          Editar
                        </button>
                      )}
                      {(shift.status === "DRAFT" || shift.status === "PUBLISHED") &&
                        (confirmingCancelId === shift.id ? (
                          <span className="flex gap-1">
                            <button
                              type="button"
                              onClick={() => handleCancelConfirmed(shift.id)}
                              className="rounded border border-red-600 px-2 py-0.5 text-red-600"
                            >
                              Confirmar cancelamento
                            </button>
                            <button type="button" onClick={() => setConfirmingCancelId(null)} className="rounded border px-2 py-0.5">
                              Voltar
                            </button>
                          </span>
                        ) : (
                          <button type="button" onClick={() => setConfirmingCancelId(shift.id)} className="rounded border px-2 py-0.5">
                            Cancelar
                          </button>
                        ))}
                    </div>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
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
    <tr className="border-b bg-gray-50">
      <td className="py-1 pr-3">
        <input value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} className="w-full rounded border px-1" />
      </td>
      <td className="py-1 pr-3">
        <input type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} className="rounded border px-1" />
      </td>
      <td className="py-1 pr-3">
        <input type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} className="rounded border px-1" />
      </td>
      <td className="py-1 pr-3">
        <input type="number" step="0.01" value={form.valueReais} onChange={(e) => setForm({ ...form, valueReais: e.target.value })} className="w-20 rounded border px-1" />
      </td>
      <td className="py-1 pr-3">{STATUS_LABEL[shift.status] ?? shift.status}</td>
      <td className="py-1">
        <div className="flex gap-2">
          <button type="button" onClick={() => onSave(form)} className="rounded bg-black px-2 py-0.5 text-white">
            Salvar
          </button>
          <button type="button" onClick={onCancel} className="rounded border px-2 py-0.5">
            Cancelar
          </button>
        </div>
      </td>
    </tr>
  );
}
