import { Body, Controller, Param, Post } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../identity/decorators/roles.decorator";
import { CurrentUser } from "../identity/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import { ApplyToShiftUseCase, type ApplyToShiftInput } from "./apply-to-shift.use-case";
import { ReviewApplicationUseCase, type ReviewApplicationInput } from "./review-application.use-case";

@Controller("applications")
export class ApplicationsController {
  constructor(
    private readonly applyToShift: ApplyToShiftUseCase,
    private readonly reviewApplication: ReviewApplicationUseCase,
  ) {}

  @Post()
  @Roles(UserRole.DOCTOR)
  async apply(@CurrentUser() actor: AuthenticatedUser, @Body() body: ApplyToShiftInput) {
    return this.applyToShift.execute(actor, body);
  }

  @Post(":id/review")
  @Roles(UserRole.HOSPITAL_ADMIN)
  async review(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: ReviewApplicationInput,
  ) {
    return this.reviewApplication.execute(actor, id, body);
  }
}
