import { Controller, Get, Param, Post, Query } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../identity/decorators/roles.decorator";
import { CurrentUser } from "../identity/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import { InAppService } from "./in-app.service";

/** Notificações in-app do usuário autenticado — sempre as próprias, nunca de terceiros (ver InAppService/RLS notification_recipient_*). */
@Controller("notifications")
@Roles(UserRole.DOCTOR, UserRole.HOSPITAL_ADMIN, UserRole.SUPERADMIN)
export class NotificationsController {
  constructor(private readonly inApp: InAppService) {}

  @Get()
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.inApp.listForUser(
      actor.id,
      page ? Number(page) : undefined,
      pageSize ? Number(pageSize) : undefined,
    );
  }

  @Post(":id/read")
  async markRead(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string) {
    await this.inApp.markRead(actor.id, id);
    return { ok: true };
  }
}
