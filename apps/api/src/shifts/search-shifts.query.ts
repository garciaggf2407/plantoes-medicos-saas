import { BadRequestException, Injectable } from "@nestjs/common";
import { ShiftStatus, type Prisma } from "@prisma/client";
import { TenantContextService } from "../organizations/tenant-context";

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

function parseUtcDateFilter(value: string, field: string): Date {
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

      return { items, page, pageSize, total };
    });
  }
}
