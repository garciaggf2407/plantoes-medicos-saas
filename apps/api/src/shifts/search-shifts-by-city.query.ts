import { BadRequestException, Injectable } from "@nestjs/common";
import type { Span } from "@opentelemetry/api";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import { ListCitiesUseCase } from "../organizations/list-cities.use-case";
import { withSpan } from "../observability/telemetry";
import { logEvent } from "../observability/structured-logger";
import { SearchShiftsQuery, type SearchShiftsResult } from "./search-shifts.query";

export interface SearchShiftsByCityFilters {
  /** Se omitida, resolve a cidade do DoctorProfile do actor autenticado. */
  city?: string;
  specialty?: string;
  minValueCents?: number;
  maxValueCents?: number;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

/**
 * Busca de plantões agregando TODOS os hospitais de uma cidade.
 *
 * SearchShiftsFilters.organizationId em SearchShiftsQuery é obrigatório
 * -- aquela busca é sempre escopada a UM hospital por vez (RLS via
 * TenantContextService.withTenantScope de um único organizationId por
 * transação). Uma cidade real tem N hospitais (dezenas, não milhares),
 * então esta classe resolve os organizationIds da cidade (via
 * ListCitiesUseCase -- mesma fonte de GET /cities) e chama
 * SearchShiftsQuery.execute UMA VEZ POR HOSPITAL, EM PARALELO
 * (Promise.all). Cada chamada já é seguramente escopada pela query
 * existente (nunca DRAFT/FILLED/CANCELLED, nunca de outro tenant) --
 * nenhuma política de RLS nova é criada aqui, só orquestração e merge.
 *
 * Paginação em memória: cada hospital é consultado pedindo
 * `page * pageSize` linhas (não só a página pedida), porque no pior
 * caso todos os itens da página final vêm de um único hospital depois
 * do merge global. O custo cresce com `page`, o que é aceitável para o
 * tamanho real de uma cidade (nunca a base inteira da plataforma).
 */
@Injectable()
export class SearchShiftsByCityQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly listCities: ListCitiesUseCase,
    private readonly searchShifts: SearchShiftsQuery,
  ) {}

  async execute(actor: AuthenticatedUser, filters: SearchShiftsByCityFilters): Promise<SearchShiftsResult> {
    return withSpan("shifts.search_by_city", {}, (span) => this.doExecute(actor, filters, span));
  }

  private async doExecute(
    actor: AuthenticatedUser,
    filters: SearchShiftsByCityFilters,
    span: Span,
  ): Promise<SearchShiftsResult> {
    const city = await this.resolveCity(actor, filters.city);

    const page = filters.page && filters.page > 0 ? Math.floor(filters.page) : 1;
    const pageSize = filters.pageSize
      ? Math.min(Math.max(1, Math.floor(filters.pageSize)), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

    const organizationIds = await this.listCities.organizationIdsForCity(city);
    span.setAttribute("shifts.city", city);
    span.setAttribute("shifts.city_organization_count", organizationIds.length);

    if (organizationIds.length === 0) {
      return { items: [], page, pageSize, total: 0 };
    }

    const perHospitalPageSize = Math.min(page * pageSize, MAX_PAGE_SIZE * 1000);
    const results = await Promise.all(
      organizationIds.map((organizationId) =>
        this.searchShifts.execute({
          organizationId,
          specialty: filters.specialty,
          minValueCents: filters.minValueCents,
          maxValueCents: filters.maxValueCents,
          from: filters.from,
          to: filters.to,
          page: 1,
          pageSize: perHospitalPageSize,
        }),
      ),
    );

    const merged = results.flatMap((result) => result.items);
    merged.sort((a, b) => {
      const byStart = a.startsAt.getTime() - b.startsAt.getTime();
      return byStart !== 0 ? byStart : a.id.localeCompare(b.id);
    });

    const total = results.reduce((sum, result) => sum + result.total, 0);
    const start = (page - 1) * pageSize;
    const items = merged.slice(start, start + pageSize);

    logEvent("shifts.search_by_city", { city, organizationCount: organizationIds.length, resultCount: items.length, page });

    return { items, page, pageSize, total };
  }

  /**
   * Cidade explícita (trim) quando informada; caso contrário, a cidade
   * cadastrada no perfil do médico autenticado. Sem nenhuma das duas,
   * falha explicitamente (400) -- nunca cai silenciosamente em lista
   * vazia nem em erro genérico (médico sem cidade cadastrada é um caso
   * legado esperado, não um bug).
   */
  private async resolveCity(actor: AuthenticatedUser, requestedCity?: string): Promise<string> {
    const trimmed = requestedCity?.trim();
    if (trimmed) {
      return trimmed;
    }

    const doctorProfile = await this.prisma.doctorProfile.findUnique({
      where: { userId: actor.id },
      select: { city: true },
    });

    if (!doctorProfile?.city) {
      throw new BadRequestException(
        "Nenhuma cidade informada e o médico não tem cidade cadastrada no perfil — especifique city ou organizationId",
      );
    }

    return doctorProfile.city;
  }
}
