import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../identity/decorators/roles.decorator";
import { CurrentUser } from "../identity/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import { ShiftCommandsService, type DraftShiftInput, type EditShiftInput } from "./shift-commands.service";
import { SearchShiftsQuery } from "./search-shifts.query";

interface SearchShiftsQueryParams {
  organizationId: string;
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
  ) {}

  @Get("search")
  @Roles(UserRole.DOCTOR, UserRole.HOSPITAL_ADMIN)
  async search(@CurrentUser() _actor: AuthenticatedUser, @Query() query: SearchShiftsQueryParams) {
    return this.searchShifts.execute({
      organizationId: query.organizationId,
      specialty: query.specialty,
      minValueCents: query.minValueCents !== undefined ? Number(query.minValueCents) : undefined,
      maxValueCents: query.maxValueCents !== undefined ? Number(query.maxValueCents) : undefined,
      from: query.from,
      to: query.to,
      page: query.page !== undefined ? Number(query.page) : undefined,
      pageSize: query.pageSize !== undefined ? Number(query.pageSize) : undefined,
    });
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
