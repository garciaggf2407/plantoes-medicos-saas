import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../identity/decorators/roles.decorator";
import { CurrentUser } from "../identity/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import { TenantContextService } from "../organizations/tenant-context";
import { ShiftCommandsService, type DraftShiftInput, type EditShiftInput } from "./shift-commands.service";
import { SearchShiftsQuery } from "./search-shifts.query";
import { SearchShiftsByCityQuery } from "./search-shifts-by-city.query";

interface SearchShiftsQueryParams {
  /** Ao menos um entre organizationId e city é esperado; sem nenhum, usa a cidade cadastrada do médico autenticado (BP-2026-07-13-001). */
  organizationId?: string;
  city?: string;
  specialty?: string;
  minValueCents?: string;
  maxValueCents?: string;
  from?: string;
  to?: string;
  page?: string;
  pageSize?: string;
}

@Controller("shifts")
@Roles(UserRole.HOSPITAL_ADMIN)
export class ShiftsController {
  constructor(
    private readonly shiftCommands: ShiftCommandsService,
    private readonly searchShifts: SearchShiftsQuery,
    private readonly searchShiftsByCity: SearchShiftsByCityQuery,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Lista TODOS os plantões (qualquer status) do hospital ativo do admin. */
  @Get()
  async listMine(@CurrentUser() actor: AuthenticatedUser) {
    const organizationId = this.tenantContext.requireHospitalOrganizationId(actor);
    return this.searchShifts.listForAdmin(organizationId);
  }

  /**
   * organizationId presente: exatamente o comportamento pré-existente
   * (retrocompatibilidade — mesma chamada, zero lógica nova nesse
   * caminho). Sem organizationId: busca por cidade (city explícita ou,
   * na ausência dela, a cidade cadastrada no perfil do médico
   * autenticado) — ver SearchShiftsByCityQuery.
   */
  @Get("search")
  @Roles(UserRole.DOCTOR, UserRole.HOSPITAL_ADMIN)
  async search(@CurrentUser() actor: AuthenticatedUser, @Query() query: SearchShiftsQueryParams) {
    const commonFilters = {
      specialty: query.specialty,
      minValueCents: query.minValueCents !== undefined ? Number(query.minValueCents) : undefined,
      maxValueCents: query.maxValueCents !== undefined ? Number(query.maxValueCents) : undefined,
      from: query.from,
      to: query.to,
      page: query.page !== undefined ? Number(query.page) : undefined,
      pageSize: query.pageSize !== undefined ? Number(query.pageSize) : undefined,
    };

    if (query.organizationId) {
      return this.searchShifts.execute({ organizationId: query.organizationId, ...commonFilters });
    }

    return this.searchShiftsByCity.execute(actor, { city: query.city, ...commonFilters });
  }

  @Get(":id")
  @Roles(UserRole.DOCTOR, UserRole.HOSPITAL_ADMIN)
  async getById(@Query("organizationId") organizationId: string, @Param("id") id: string) {
    return this.searchShifts.getPublishedById(organizationId, id);
  }

  @Post()
  async draft(@CurrentUser() actor: AuthenticatedUser, @Body() body: DraftShiftInput) {
    return this.shiftCommands.draftShift(actor, body);
  }

  @Patch(":id")
  async edit(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: EditShiftInput,
  ) {
    return this.shiftCommands.editShift(actor, id, body);
  }

  @Post(":id/publish")
  async publish(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string) {
    return this.shiftCommands.publishShift(actor, id);
  }

  @Post(":id/cancel")
  async cancel(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string) {
    return this.shiftCommands.cancelShift(actor, id);
  }
}
