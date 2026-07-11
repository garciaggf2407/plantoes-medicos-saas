import { Controller, ForbiddenException, Get, Param, Post, Query } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../identity/decorators/roles.decorator";
import { CurrentUser } from "../identity/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import { TenantContextService } from "../organizations/tenant-context";
import { InAppService } from "./in-app.service";
import { OutboxService } from "./outbox.service";

/** Notificações in-app do usuário autenticado — sempre as próprias, nunca de terceiros (ver InAppService/RLS notification_recipient_*). */
@Controller("notifications")
@Roles(UserRole.DOCTOR, UserRole.HOSPITAL_ADMIN, UserRole.SUPERADMIN)
export class NotificationsController {
  constructor(
    private readonly inApp: InAppService,
    private readonly outbox: OutboxService,
    private readonly tenantContext: TenantContextService,
  ) {}

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

  /**
   * Eventos que esgotaram as tentativas do worker (T-5.1.2), do
   * hospital ativo do admin. Antes só consultável direto no banco —
   * gap de observabilidade real encontrado em auditoria (o objetivo
   * declarado da outbox era exatamente evitar perda silenciosa, mas
   * nada expunha os dead-letters via API).
   */
  @Get("dead-letter")
  async listDeadLetter(@CurrentUser() actor: AuthenticatedUser) {
    if (actor.role !== UserRole.HOSPITAL_ADMIN) {
      throw new ForbiddenException("Somente hospital_admin consulta dead-letters do hospital");
    }
    const organizationId = this.tenantContext.requireHospitalOrganizationId(actor);
    return this.tenantContext.withTenantScope(organizationId, (tx) =>
      this.outbox.listDeadLetter(tx, organizationId),
    );
  }
}
