"use client";

import { useMemo, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

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
 * único sinal (acessibilidade — daltonismo/leitores de tela). Hex
 * abaixo usa as escalas Tailwind da paleta semântica, com o passo
 * ajustado por status (600 ou 700) para garantir >=4.5:1 de contraste
 * sobre branco tanto como texto quanto como fundo de evento —
 * FullCalendar exige cor literal, não aceita className.
 */
const STATUS_META: Record<ShiftCalendarStatus, { label: string; symbol: string; color: string; textClass: string }> = {
  DRAFT: { label: "Rascunho", symbol: "◇", color: "#64748b", textClass: "text-slate-500" },
  PUBLISHED: { label: "Publicado", symbol: "○", color: "#2563eb", textClass: "text-blue-600" },
  PENDING: { label: "Candidatura pendente", symbol: "◐", color: "#b45309", textClass: "text-amber-700" },
  APPROVED: { label: "Aprovado", symbol: "●", color: "#047857", textClass: "text-emerald-700" },
  FILLED: { label: "Preenchido", symbol: "■", color: "#047857", textClass: "text-emerald-700" },
  CANCELLED: { label: "Cancelado", symbol: "✕", color: "#dc2626", textClass: "text-red-600" },
  REJECTED: { label: "Rejeitado", symbol: "✕", color: "#dc2626", textClass: "text-red-600" },
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
        <Button
          type="button"
          size="sm"
          variant={view === "dayGridMonth" ? "primary" : "secondary"}
          onClick={() => setView("dayGridMonth")}
          aria-pressed={view === "dayGridMonth"}
        >
          Mês
        </Button>
        <Button
          type="button"
          size="sm"
          variant={view === "timeGridWeek" ? "primary" : "secondary"}
          onClick={() => setView("timeGridWeek")}
          aria-pressed={view === "timeGridWeek"}
        >
          Semana
        </Button>
      </div>

      <ul aria-label="Legenda de estados do plantão" className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {Object.entries(STATUS_META).map(([status, meta]) => (
          <li key={status} className={meta.textClass}>
            <span aria-hidden="true">{meta.symbol}</span> {meta.label}
          </li>
        ))}
      </ul>

      <div className="w-full overflow-x-auto rounded-card bg-surface p-2 shadow-card">
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

      <h2 className="mt-6 mb-2 text-sm font-semibold text-label">Lista de plantões (alternativa textual)</h2>
      {sortedForList.length === 0 ? (
        <EmptyState message="Nenhum plantão no período." />
      ) : (
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Lista de plantões equivalente ao calendário visual, navegável por teclado</caption>
          <thead>
            <tr className="border-b border-separator text-left">
              <th scope="col" className="py-1.5 pr-3 font-medium text-label-secondary">Especialidade</th>
              <th scope="col" className="py-1.5 pr-3 font-medium text-label-secondary">Início</th>
              <th scope="col" className="py-1.5 pr-3 font-medium text-label-secondary">Fim</th>
              <th scope="col" className="py-1.5 font-medium text-label-secondary">Estado</th>
            </tr>
          </thead>
          <tbody>
            {sortedForList.map((event) => {
              const meta = event.status ? STATUS_META[event.status] : undefined;
              return (
                <tr
                  key={event.id}
                  tabIndex={0}
                  className="border-b border-separator focus:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
                >
                  <td className="py-1.5 pr-3 text-label">{event.title}</td>
                  <td className="py-1.5 pr-3 text-label-secondary">{formatDateTime(event.startsAt)}</td>
                  <td className="py-1.5 pr-3 text-label-secondary">{formatDateTime(event.endsAt)}</td>
                  <td className={`py-1.5 ${meta?.textClass ?? "text-label-secondary"}`}>
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
