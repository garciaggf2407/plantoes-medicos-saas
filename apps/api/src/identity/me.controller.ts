import { Controller, Get } from "@nestjs/common";
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
}
