import { Body, Controller, Post } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../identity/decorators/roles.decorator";
import { CurrentUser } from "../identity/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import { ApplyToShiftUseCase, type ApplyToShiftInput } from "./apply-to-shift.use-case";

@Controller("applications")
export class ApplicationsController {
  constructor(private readonly applyToShift: ApplyToShiftUseCase) {}

  @Post()
  @Roles(UserRole.DOCTOR)
  async apply(@CurrentUser() actor: AuthenticatedUser, @Body() body: ApplyToShiftInput) {
    return this.applyToShift.execute(actor, body);
  }
}
