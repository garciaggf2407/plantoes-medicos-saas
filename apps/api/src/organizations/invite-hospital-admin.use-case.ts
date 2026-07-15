import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { UserRole } from "@prisma/client";
import { TenantContextService } from "./tenant-context";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";

export interface InviteHospitalAdminInput {
  email: string;
}

export interface InviteHospitalAdminResult {
  invitedAdminUserId: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Convite de admin para um hospital JÁ EXISTENTE -- ao contrário de
 * ProvisionOrganizationUseCase, que só convida um admin no mesmo passo
 * em que cria a organização. Necessário porque hospitais agora também
 * nascem sem admin nenhum (seed-cnes-hospitals.mjs cria só a
 * Organization, a partir de dados reais do CNES) -- sem esta rota,
 * esses hospitais nunca teriam um HOSPITAL_ADMIN possível.
 *
 * Mesmo padrão de convite pendente: oidcSubject "pending:<uuid>",
 * reconciliado no primeiro login com o mesmo email (ver
 * AuthService.resolveOrProvisionUser). Permite múltiplos admins por
 * hospital -- não há invariante em nenhum outro lugar do sistema que
 * imponha "um admin só" por organização.
 */
@Injectable()
export class InviteHospitalAdminUseCase {
  constructor(private readonly tenantContext: TenantContextService) {}

  async execute(
    actor: AuthenticatedUser,
    organizationId: string,
    input: InviteHospitalAdminInput,
  ): Promise<InviteHospitalAdminResult> {
    if (actor.role !== UserRole.SUPERADMIN) {
      throw new ForbiddenException("Somente superadmin pode convidar administrador de hospital");
    }

    const email = input.email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) {
      throw new BadRequestException("Email do administrador é inválido");
    }

    return this.tenantContext.withTenantScope(organizationId, async (tx) => {
      const organization = await tx.organization.findUnique({ where: { id: organizationId } });
      if (!organization) {
        throw new NotFoundException("Hospital não encontrado");
      }

      const existing = await tx.user.findUnique({ where: { email } });
      if (existing) {
        throw new BadRequestException("Já existe um usuário com este email");
      }

      const invitedAdmin = await tx.user.create({
        data: {
          oidcSubject: `pending:${randomUUID()}`,
          email,
          role: UserRole.HOSPITAL_ADMIN,
          organizationId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: actor.id,
          action: "organization.admin_invited",
          targetType: "Organization",
          targetId: organizationId,
          justification: `Admin convidado para hospital "${organization.name}" já existente: ${email}`,
        },
      });

      return { invitedAdminUserId: invitedAdmin.id };
    });
  }
}
