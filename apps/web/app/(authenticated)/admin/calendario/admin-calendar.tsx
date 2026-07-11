"use client";

import { useEffect, useState } from "react";
import type { AdminShiftDto } from "@plantoes/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import { ShiftCalendar, type ShiftCalendarEvent } from "@/components/shift-calendar";

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; events: ShiftCalendarEvent[] };

/**
 * Calendário administrativo: mostra plantões PUBLISHED/FILLED do
 * hospital ativo, reutilizando o mesmo componente ShiftCalendar do
 * portal do médico — nenhuma lógica de calendário duplicada.
 */
export function AdminCalendar() {
  const meState = useMe();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (meState.status !== "ready") return;
    apiFetch<AdminShiftDto[]>("/shifts")
      .then((shifts) =>
        setState({
          status: "ready",
          events: shifts
            .filter((s) => s.status === "PUBLISHED" || s.status === "FILLED")
            .map((s) => ({ id: s.id, title: s.specialty, startsAt: s.startsAt, endsAt: s.endsAt, status: s.status })),
        }),
      )
      .catch((err: unknown) => {
        const message = err instanceof ApiError ? `Não foi possível carregar o calendário (erro ${err.status})` : "Não foi possível carregar o calendário";
        setState({ status: "error", message });
      });
  }, [meState.status]);

  if (meState.status === "loading") return <p role="status">Carregando…</p>;
  if (meState.status === "error") return <p role="alert" className="text-red-600">Não foi possível carregar seus dados.</p>;

  return (
    <div>
      {state.status === "loading" && <p role="status">Carregando…</p>}
      {state.status === "error" && <p role="alert" className="text-red-600">{state.message}</p>}
      {state.status === "ready" && <ShiftCalendar events={state.events} />}
    </div>
  );
}
