import { Controller, Get, Query } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../identity/decorators/roles.decorator";
import { CurrentUser } from "../identity/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import { CalendarQuery } from "./calendar.query";

@Controller("calendar")
@Roles(UserRole.DOCTOR)
export class CalendarController {
  constructor(private readonly calendarQuery: CalendarQuery) {}

  @Get()
  async get(
    @CurrentUser() actor: AuthenticatedUser,
    @Query("from") from: string,
    @Query("to") to: string,
  ) {
    return this.calendarQuery.execute(actor, { from, to });
  }
}
