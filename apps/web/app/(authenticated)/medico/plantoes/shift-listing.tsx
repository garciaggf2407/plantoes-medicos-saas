"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { SearchShiftsResponse } from "@plantoes/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";

const PAGE_SIZE = 10;

const INPUT_CLASS =
  "rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600";

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
    return <EmptyState message="Informe o hospital para buscar plantões (parâmetro organizationId na URL)." />;
  }

  return (
    <div>
      <form
        onSubmit={handleFilterSubmit}
        aria-label="Filtros de busca"
        className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          Especialidade
          <input name="specialty" defaultValue={specialty} type="text" className={INPUT_CLASS} placeholder="Ex.: Cardiologia" />
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          Valor mínimo (R$)
          <input name="minValueReais" defaultValue={minValueReais} type="number" min={0} step="0.01" className={INPUT_CLASS} />
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          Valor máximo (R$)
          <input name="maxValueReais" defaultValue={maxValueReais} type="number" min={0} step="0.01" className={INPUT_CLASS} />
        </label>
        <Button type="submit" size="sm">
          Filtrar
        </Button>
      </form>

      {state.status === "loading" && <LoadingState message="Carregando plantões…" />}
      {state.status === "error" && <ErrorState message={state.message} />}
      {state.status === "ready" && state.data.items.length === 0 && (
        <EmptyState message="Nenhum plantão encontrado com esses filtros." />
      )}
      {state.status === "ready" && state.data.items.length > 0 && (
        <>
          <ul className="flex flex-col gap-3">
            {state.data.items.map((shift) => (
              <li key={shift.id}>
                <Link href={`/medico/plantoes/${shift.id}?organizationId=${organizationId}`} className="block">
                  <Card className="flex flex-wrap items-center justify-between gap-3 transition-colors hover:bg-slate-50">
                    <div>
                      <Badge variant="neutral" className="mb-1.5">
                        {shift.specialty}
                      </Badge>
                      <div className="text-sm text-slate-600">
                        {formatDateTime(shift.startsAt)} — {formatDateTime(shift.endsAt)}
                      </div>
                    </div>
                    <div className="font-medium text-slate-900">{centsToReais(shift.valueCents)}</div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>

          <nav aria-label="Paginação" className="mt-4 flex items-center gap-3">
            <Button type="button" variant="secondary" size="sm" onClick={() => goToPage(page - 1)} disabled={page <= 1}>
              Anterior
            </Button>
            <span aria-live="polite" className="text-sm text-slate-600">
              Página {state.data.page} de {Math.max(1, Math.ceil(state.data.total / state.data.pageSize))}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => goToPage(page + 1)}
              disabled={page * PAGE_SIZE >= state.data.total}
            >
              Próxima
            </Button>
          </nav>
        </>
      )}
    </div>
  );
}
