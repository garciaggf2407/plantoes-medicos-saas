"use client";

import { useMemo, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";

export type ShiftCalendarStatus = "DRAFT" | "PUBLISHED" | "PENDING" | "APPROVED" | "FILLED" | "CANCELLED" | "REJECTED";

export interface ShiftCalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status?: ShiftCalendarStatus;
}

/**
 * Legenda de estados: cor É reforçada por texto/símbolo, nunca é o
 * único sinal (acessibilidade — daltonismo/leitores de tela).
 */
const STATUS_META: Record<ShiftCalendarStatus, { label: string; symbol: string; color: string }> = {
  DRAFT: { label: "Rascunho", symbol: "◇", color: "#9ca3af" },
  PUBLISHED: { label: "Publicado", symbol: "○", color: "#3b82f6" },
  PENDING: { label: "Candidatura pendente", symbol: "◐", color: "#f59e0b" },
  APPROVED: { label: "Aprovado", symbol: "●", color: "#16a34a" },
  FILLED: { label: "Preenchido", symbol: "■", color: "#0f766e" },
  CANCELLED: { label: "Cancelado", symbol: "✕", color: "#dc2626" },
  REJECTED: { label: "Rejeitado", symbol: "✕", color: "#dc2626" },
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

/**
 * Calendário visual reutilizável (médico e admin). Visões mensal e
 * semanal renderizam o mesmo array de eventos — nunca buscam dados
 * de fontes diferentes. Uma lista textual equivalente, sempre
 * presente e navegável por teclado (links/itens semânticos, sem
 * widget customizado), garante alternativa acessível ao grid visual.
 */
export function ShiftCalendar({ events }: { events: ShiftCalendarEvent[] }) {
  const [view, setView] = useState<"dayGridMonth" | "timeGridWeek">("dayGridMonth");

  const calendarEvents = useMemo(
    () =>
      events.map((event) => {
        const meta = event.status ? STATUS_META[event.status] : undefined;
        return {
          id: event.id,
          title: meta ? `${meta.symbol} ${event.title}` : event.title,
          start: event.startsAt,
          end: event.endsAt,
          backgroundColor: meta?.color,
          borderColor: meta?.color,
        };
      }),
    [events],
  );

  const sortedForList = useMemo(
    () => [...events].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()),
    [events],
  );

  return (
    <div>
      <div role="group" aria-label="Visão do calendário" className="mb-3 flex gap-2">
        <button
          type="button"
          onClick={() => setView("dayGridMonth")}
          aria-pressed={view === "dayGridMonth"}
          className={`rounded border px-3 py-1 ${view === "dayGridMonth" ? "bg-black text-white" : ""}`}
        >
          Mês
        </button>
        <button
          type="button"
          onClick={() => setView("timeGridWeek")}
          aria-pressed={view === "timeGridWeek"}
          className={`rounded border px-3 py-1 ${view === "timeGridWeek" ? "bg-black text-white" : ""}`}
        >
          Semana
        </button>
      </div>

      <ul aria-label="Legenda de estados do plantão" className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {Object.entries(STATUS_META).map(([status, meta]) => (
          <li key={status} style={{ color: meta.color }}>
            <span aria-hidden="true">{meta.symbol}</span> {meta.label}
          </li>
        ))}
      </ul>

      <div className="w-full overflow-x-auto">
        <FullCalendar
          key={view}
          plugins={[dayGridPlugin, timeGridPlugin]}
          initialView={view}
          headerToolbar={{ left: "prev,next today", center: "title", right: "" }}
          events={calendarEvents}
          height="auto"
          locale="pt-br"
        />
      </div>

      <h2 className="mt-6 mb-2 text-sm font-semibold">Lista de plantões (alternativa textual)</h2>
      {sortedForList.length === 0 ? (
        <p role="status">Nenhum plantão no período.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Lista de plantões equivalente ao calendário visual, navegável por teclado</caption>
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="py-1 pr-3">Especialidade</th>
              <th scope="col" className="py-1 pr-3">Início</th>
              <th scope="col" className="py-1 pr-3">Fim</th>
              <th scope="col" className="py-1">Estado</th>
            </tr>
          </thead>
          <tbody>
            {sortedForList.map((event) => {
              const meta = event.status ? STATUS_META[event.status] : undefined;
              return (
                <tr key={event.id} tabIndex={0} className="border-b focus:bg-gray-100">
                  <td className="py-1 pr-3">{event.title}</td>
                  <td className="py-1 pr-3">{formatDateTime(event.startsAt)}</td>
                  <td className="py-1 pr-3">{formatDateTime(event.endsAt)}</td>
                  <td className="py-1" style={{ color: meta?.color }}>
                    {meta ? `${meta.symbol} ${meta.label}` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
