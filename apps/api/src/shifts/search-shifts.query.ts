import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ShiftStatus, type Prisma } from "@prisma/client";
import type { Span } from "@opentelemetry/api";
import { TenantContextService } from "../organizations/tenant-context";
import { telemetry, withSpan } from "../observability/telemetry";
import { logEvent } from "../observability/structured-logger";

export interface SearchShiftsFilters {
  organizationId: string;
  specialty?: string;
  minValueCents?: number;
  maxValueCents?: number;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface SearchShiftsResult {
  items: Array<{
    id: string;
    specialty: string;
    valueCents: number;
    startsAt: Date;
    endsAt: Date;
  }>;
  page: number;
  pageSize: number;
  total: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

// Mesma disciplina de shift-commands.service.ts (ISO_UTC_PATTERN):
// exige designador de fuso explícito ("Z" ou +HH:mm/-HH:mm). Sem
// isso, `new Date("2026-08-01T00:00:00")` (sem offset) é interpretado
// no fuso LOCAL DO SERVIDOR pelo motor JS, enquanto startsAt/endsAt
// são sempre armazenados/comparados em UTC -- num servidor não-UTC,
// isso desloca o limite from/to pelo offset do servidor, incluindo ou
// excluindo plantões incorretamente perto da borda do filtro. Mesma
// classe de bug já corrigida no worker (T-5.1.2, comparação de
// available_at); aqui na busca era um bug real ainda não corrigido,
// encontrado em auditoria.
// eslint-disable-next-line security/detect-unsafe-regex
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function parseUtcDateFilter(value: string, field: string): Date {
  if (!ISO_UTC_PATTERN.test(value)) {
    throw new BadRequestException(`${field} deve ser ISO-8601 com timezone explícito (ex.: 2026-08-01T08:00:00Z)`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} não é uma data válida`);
  }
  return date;
}

/**
 * Busca paginada de plantões PUBLICADOS, sempre escopada a um único
 * hospital (organizationId nunca é omitido — quem chama decide qual
 * hospital navegar, mas RLS garante que só linhas PUBLISHED daquele
 * organizationId retornam, nunca DRAFT/FILLED/CANCELLED nem de
 * outro tenant).
 *
 * Índices que sustentam esta consulta (ver migration
 * 20260710204255_init):
 *   - shifts_organization_id_status_idx (organization_id, status)
 *     cobre o filtro base org+PUBLISHED.
 *   - shifts_organization_id_specialty_value_cents_idx
 *     (organization_id, specialty, value_cents) cobre a combinação
 *     de especialidade + faixa de valor dentro do mesmo hospital.
 * Paginação por (startsAt, id) garante ordenação determinística
 * mesmo com startsAt duplicado entre plantões.
 */
@Injectable()
export class SearchShiftsQuery {
  constructor(private readonly tenantContext: TenantContextService) {}

  async execute(filters: SearchShiftsFilters): Promise<SearchShiftsResult> {
    return withSpan("shifts.search", { "shifts.organization_id": filters.organizationId }, async (span) =>
      this.doExecute(filters, span),
    );
  }

  private async doExecute(filters: SearchShiftsFilters, span: Span): Promise<SearchShiftsResult> {
    const page = filters.page && filters.page > 0 ? Math.floor(filters.page) : 1;
    const pageSize = filters.pageSize
      ? Math.min(Math.max(1, Math.floor(filters.pageSize)), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

    if (
      filters.minValueCents !== undefined &&
      filters.maxValueCents !== undefined &&
      filters.minValueCents > filters.maxValueCents
    ) {
      throw new BadRequestException("minValueCents não pode ser maior que maxValueCents");
    }

    const from = filters.from ? parseUtcDateFilter(filters.from, "from") : undefined;
    const to = filters.to ? parseUtcDateFilter(filters.to, "to") : undefined;
    if (from && to && from.getTime() > to.getTime()) {
      throw new BadRequestException("from não pode ser posterior a to");
    }

    return this.tenantContext.withTenantScope(filters.organizationId, async (tx) => {
      const where: Prisma.ShiftWhereInput = {
        organizationId: filters.organizationId,
        status: ShiftStatus.PUBLISHED,
        ...(filters.specialty ? { specialty: { equals: filters.specialty, mode: "insensitive" } } : {}),
        ...(filters.minValueCents !== undefined || filters.maxValueCents !== undefined
          ? {
              valueCents: {
                ...(filters.minValueCents !== undefined ? { gte: filters.minValueCents } : {}),
                ...(filters.maxValueCents !== undefined ? { lte: filters.maxValueCents } : {}),
              },
            }
          : {}),
        ...(from || to
          ? {
              startsAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      };

      const [items, total] = await Promise.all([
        tx.shift.findMany({
          where,
          orderBy: [{ startsAt: "asc" }, { id: "asc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: { id: true, specialty: true, valueCents: true, startsAt: true, endsAt: true },
        }),
        tx.shift.count({ where }),
      ]);

      span.setAttribute("shifts.result_count", items.length);
      telemetry.shiftSearchCounter.add(1);
      logEvent("shifts.search", { organizationId: filters.organizationId, resultCount: items.length, page });

      return { items, page, pageSize, total };
    });
  }

  /**
   * Detalhe de um único plantão PUBLICADO, para a tela de
   * candidatura. Mesma regra de visibilidade da busca: nunca
   * DRAFT/FILLED/CANCELLED nem de outro tenant.
   */
  async getPublishedById(organizationId: string, shiftId: string) {
    const shift = await this.tenantContext.withTenantScope(organizationId, (tx) =>
      tx.shift.findFirst({
        where: { id: shiftId, organizationId, status: ShiftStatus.PUBLISHED },
        select: { id: true, specialty: true, valueCents: true, startsAt: true, endsAt: true },
      }),
    );
    if (!shift) {
      throw new NotFoundException("Plantão não encontrado");
    }
    return shift;
  }

  /**
   * Lista TODOS os plantões do hospital ativo do admin, em qualquer
   * status (DRAFT/PUBLISHED/FILLED/CANCELLED) — ao contrário de
   * `execute`, que só mostra PUBLISHED para descoberta pelo médico.
   * Usada pela tela de gestão administrativa.
   */
  async listForAdmin(organizationId: string) {
    return this.tenantContext.withTenantScope(organizationId, (tx) =>
      tx.shift.findMany({
        where: { organizationId },
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        select: { id: true, specialty: true, valueCents: true, startsAt: true, endsAt: true, status: true },
      }),
    );
  }
}
