"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { SearchShiftsResponse } from "@plantoes/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { LoadingState } from "@/components/ui/loading-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { CitySelector } from "./city-selector";

const PAGE_SIZE = 10;

const DEFAULT_DESCRIPTION = "Filtre e candidate-se aos plantões publicados.";
const NO_CITY_MESSAGE = "Escolha uma cidade para ver os plantões disponíveis.";

const INPUT_CLASS =
  "rounded-control border border-separator px-2.5 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

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
  const city = searchParams.get("city") ?? "";
  const specialty = searchParams.get("specialty") ?? "";
  const minValueReais = searchParams.get("minValueReais") ?? "";
  const maxValueReais = searchParams.get("maxValueReais") ?? "";
  const page = Number(searchParams.get("page") ?? "1") || 1;

  // organizationId (deep link legado de um hospital específico) tem
  // prioridade sobre city se ambos vierem na URL -- na prática isso só
  // acontece por um instante, entre o médico trocar de cidade e o
  // parâmetro organizationId ser removido (ver handleCityChange).
  const hasFilterTarget = Boolean(organizationId || city);

  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!hasFilterTarget) {
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });

    const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (organizationId) {
      query.set("organizationId", organizationId);
    } else {
      query.set("city", city);
    }
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
  }, [hasFilterTarget, organizationId, city, specialty, minValueReais, maxValueReais, page]);

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

  function handleCityChange(nextCity: string) {
    // Trocar de cidade sempre substitui um eventual organizationId de
    // deep link -- cidade e hospital único são alternativas, nunca
    // combinadas (ver GET /shifts/search no backend).
    updateParams({ city: nextCity || null, organizationId: null });
  }

  // organizationId (deep link de um hospital só): descrição mostra o
  // hospital daquele item, igual ao comportamento original. city
  // (multi-hospital): não há um único hospital para descrever.
  const firstHospital = organizationId && state.status === "ready" ? state.data.items[0]?.hospital : undefined;
  const description = firstHospital
    ? `${firstHospital.name}${firstHospital.city ? ` — ${firstHospital.city}` : ""}`
    : city
      ? `Plantões em ${city}.`
      : DEFAULT_DESCRIPTION;

  return (
    <div>
      <PageHeader title="Plantões disponíveis" description={description} />

      {!organizationId && (
        <div className="mb-4">
          <CitySelector value={city} onChange={handleCityChange} />
        </div>
      )}

      {!hasFilterTarget ? (
        <EmptyState message={NO_CITY_MESSAGE} />
      ) : (
        <>
          <form
            onSubmit={handleFilterSubmit}
            aria-label="Filtros de busca"
            className="mb-6 flex flex-wrap items-end gap-3 rounded-card bg-surface p-4 shadow-card"
          >
            <label className="flex flex-col gap-1 text-sm text-label-secondary">
              Especialidade
              <input name="specialty" defaultValue={specialty} type="text" className={INPUT_CLASS} placeholder="Ex.: Cardiologia" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-label-secondary">
              Valor mínimo (R$)
              <input name="minValueReais" defaultValue={minValueReais} type="number" min={0} step="0.01" className={INPUT_CLASS} />
            </label>
            <label className="flex flex-col gap-1 text-sm text-label-secondary">
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
                    <Link href={`/medico/plantoes/${shift.id}?organizationId=${shift.organizationId}`} className="block">
                      <Card className="flex flex-wrap items-center justify-between gap-3 transition-colors hover:bg-background">
                        <div>
                          <Badge variant="neutral" className="mb-1.5">
                            {shift.specialty}
                          </Badge>
                          <div className="text-sm text-label-secondary">
                            {formatDateTime(shift.startsAt)} — {formatDateTime(shift.endsAt)}
                          </div>
                        </div>
                        <div className="font-medium text-label">{centsToReais(shift.valueCents)}</div>
                      </Card>
                    </Link>
                  </li>
                ))}
              </ul>

              <nav aria-label="Paginação" className="mt-4 flex items-center gap-3">
                <Button type="button" variant="secondary" size="sm" onClick={() => goToPage(page - 1)} disabled={page <= 1}>
                  Anterior
                </Button>
                <span aria-live="polite" className="text-sm text-label-secondary">
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
        </>
      )}
    </div>
  );
}
