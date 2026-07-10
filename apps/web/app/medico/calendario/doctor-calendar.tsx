"use client";

import { useEffect, useState } from "react";
import type { CalendarEventDto } from "@plantoes/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { ShiftCalendar, type ShiftCalendarEvent } from "@/components/shift-calendar";

/** Janela fixa (mês anterior a +3 meses) — cobre navegação mensal/semanal sem refetch dinâmico. */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 4, 0));
  return { from: from.toISOString(), to: to.toISOString() };
}

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; events: ShiftCalendarEvent[] };

export function DoctorCalendar() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const { from, to } = defaultRange();
    apiFetch<CalendarEventDto[]>(`/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((events) =>
        setState({
          status: "ready",
          events: events.map((e) => ({
            id: e.shiftId,
            title: `${e.specialty} — ${e.organizationName}`,
            startsAt: e.startsAt,
            endsAt: e.endsAt,
            status: "APPROVED",
          })),
        }),
      )
      .catch((err: unknown) => {
        const message = err instanceof ApiError ? `Não foi possível carregar a agenda (erro ${err.status})` : "Não foi possível carregar a agenda";
        setState({ status: "error", message });
      });
  }, []);

  if (state.status === "loading") return <p role="status">Carregando…</p>;
  if (state.status === "error") return <p role="alert" className="text-red-600">{state.message}</p>;

  return <ShiftCalendar events={state.events} />;
}
