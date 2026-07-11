import { BadRequestException, Body, Controller, Get, Patch } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "./decorators/roles.decorator";
import { CurrentUser } from "./decorators/current-user.decorator";
import type { AuthenticatedUser } from "./guards/authentication.guard";
import { PrismaService } from "../prisma/prisma.service";

export interface MeResponse {
  id: string;
  email: string;
  role: string;
  organizationId: string | null;
  organizationName: string | null;
}

export interface EmailPreferencesInput {
  emailOptOut: boolean;
}

/** Identidade do usuário autenticado — o frontend precisa saber quem é e qual seu hospital ativo. */
@Controller("me")
@Roles(UserRole.DOCTOR, UserRole.HOSPITAL_ADMIN, UserRole.SUPERADMIN)
export class MeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async me(@CurrentUser() actor: AuthenticatedUser): Promise<MeResponse> {
    let organizationName: string | null = null;
    if (actor.organizationId) {
      const organization = await this.prisma.organization.findUnique({ where: { id: actor.organizationId } });
      organizationName = organization?.name ?? null;
    }
    return {
      id: actor.id,
      email: actor.email,
      role: actor.role,
      organizationId: actor.organizationId,
      organizationName,
    };
  }

  /** Opt-out de notificações por email (T-5.1.4) — respeitado por EmailAdapter antes de qualquer envio. */
  @Patch("email-preferences")
  async updateEmailPreferences(@CurrentUser() actor: AuthenticatedUser, @Body() body: EmailPreferencesInput) {
    if (typeof body.emailOptOut !== "boolean") {
      throw new BadRequestException("emailOptOut deve ser boolean");
    }
    const user = await this.prisma.user.update({
      where: { id: actor.id },
      data: { emailOptOut: body.emailOptOut },
      select: { emailOptOut: true },
    });
    return user;
  }
}
