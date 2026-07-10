import { Body, Controller, Param, Patch, Post } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../identity/decorators/roles.decorator";
import { CurrentUser } from "../identity/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import { ShiftCommandsService, type DraftShiftInput, type EditShiftInput } from "./shift-commands.service";

@Controller("shifts")
@Roles(UserRole.HOSPITAL_ADMIN)
export class ShiftsController {
  constructor(private readonly shiftCommands: ShiftCommandsService) {}

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
