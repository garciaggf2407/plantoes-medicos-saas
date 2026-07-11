"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { SearchShiftsResponse } from "@plantoes/shared";
import { apiFetch, ApiError } from "@/lib/api";

const PAGE_SIZE = 10;

function centsToReais(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: SearchShiftsResponse };

export function ShiftListing() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const organizationId = searchParams.get("organizationId") ?? "";
  const specialty = searchParams.get("specialty") ?? "";
  const minValueReais = searchParams.get("minValueReais") ?? "";
  const maxValueReais = searchParams.get("maxValueReais") ?? "";
  const page = Number(searchParams.get("page") ?? "1") || 1;

  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!organizationId) {
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });

    const query = new URLSearchParams({ organizationId, page: String(page), pageSize: String(PAGE_SIZE) });
    if (specialty) query.set("specialty", specialty);
    if (minValueReais) query.set("minValueCents", String(Math.round(Number(minValueReais) * 100)));
    if (maxValueReais) query.set("maxValueCents", String(Math.round(Number(maxValueReais) * 100)));

    apiFetch<SearchShiftsResponse>(`/shifts/search?${query.toString()}`)
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof ApiError
            ? `Não foi possível carregar os plantões (erro ${err.status})`
            : "Não foi possível carregar os plantões";
        setState({ status: "error", message });
      });

    return () => {
      cancelled = true;
    };
  }, [organizationId, specialty, minValueReais, maxValueReais, page]);

  function updateParams(updates: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    next.delete("page");
    router.push(`/medico/plantoes?${next.toString()}`);
  }

  function handleFilterSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    updateParams({
      specialty: String(form.get("specialty") ?? ""),
      minValueReais: String(form.get("minValueReais") ?? ""),
      maxValueReais: String(form.get("maxValueReais") ?? ""),
    });
  }

  function goToPage(nextPage: number) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("page", String(nextPage));
    router.push(`/medico/plantoes?${next.toString()}`);
  }

  if (!organizationId) {
    return (
      <p role="status">
        Informe o hospital para buscar plantões (parâmetro <code>organizationId</code> na URL).
      </p>
    );
  }

  return (
    <div>
      <form onSubmit={handleFilterSubmit} className="mb-6 flex flex-wrap gap-3" aria-label="Filtros de busca">
        <label className="flex flex-col text-sm">
          Especialidade
          <input
            name="specialty"
            defaultValue={specialty}
            type="text"
            className="rounded border px-2 py-1"
            placeholder="Ex.: Cardiologia"
          />
        </label>
        <label className="flex flex-col text-sm">
          Valor mínimo (R$)
          <input
            name="minValueReais"
            defaultValue={minValueReais}
            type="number"
            min={0}
            step="0.01"
            className="rounded border px-2 py-1"
          />
        </label>
        <label className="flex flex-col text-sm">
          Valor máximo (R$)
          <input
            name="maxValueReais"
            defaultValue={maxValueReais}
            type="number"
            min={0}
            step="0.01"
            className="rounded border px-2 py-1"
          />
        </label>
        <button type="submit" className="self-end rounded bg-black px-3 py-1 text-white">
          Filtrar
        </button>
      </form>

      {state.status === "loading" && <p role="status">Carregando…</p>}
      {state.status === "error" && (
        <p role="alert" className="text-red-600">
          {state.message}
        </p>
      )}
      {state.status === "ready" && state.data.items.length === 0 && (
        <p role="status">Nenhum plantão encontrado com esses filtros.</p>
      )}
      {state.status === "ready" && state.data.items.length > 0 && (
        <>
          <ul className="flex flex-col gap-3">
            {state.data.items.map((shift) => (
              <li key={shift.id} className="rounded border p-3">
                <Link
                  href={`/medico/plantoes/${shift.id}?organizationId=${organizationId}`}
                  className="font-medium underline"
                >
                  {shift.specialty}
                </Link>
                <div className="text-sm text-gray-600">
                  {formatDateTime(shift.startsAt)} — {formatDateTime(shift.endsAt)} · {centsToReais(shift.valueCents)}
                </div>
              </li>
            ))}
          </ul>

          <nav aria-label="Paginação" className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1}
              className="rounded border px-3 py-1 disabled:opacity-50"
            >
              Anterior
            </button>
            <span aria-live="polite">
              Página {state.data.page} de {Math.max(1, Math.ceil(state.data.total / state.data.pageSize))}
            </span>
            <button
              type="button"
              onClick={() => goToPage(page + 1)}
              disabled={page * PAGE_SIZE >= state.data.total}
              className="rounded border px-3 py-1 disabled:opacity-50"
            >
              Próxima
            </button>
          </nav>
        </>
      )}
    </div>
  );
}
