import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";

export interface ProvisionOrganizationInput {
  name: string;
  timezone: string;
  firstAdminEmail: string;
}

export interface ProvisionOrganizationResult {
  organizationId: string;
  invitedAdminUserId: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Caso de uso restrito a superadmin: cria um hospital (Organization)
 * e registra um convite pendente para o primeiro hospital_admin,
 * com evento de auditoria. O envio real do email de convite é
 * responsabilidade do worker de notificação (E-5, T-5.1.4) — aqui
 * apenas o estado convidável é persistido.
 *
 * O admin convidado recebe um oidcSubject "pending:<uuid>" que nunca
 * corresponde a um subject real emitido por um provedor OIDC; no
 * primeiro login bem-sucedido com o mesmo email, o subject
 * placeholder deve ser reconciliado com o subject real (fora do
 * escopo desta task).
 */
@Injectable()
export class ProvisionOrganizationUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(
    actor: AuthenticatedUser,
    input: ProvisionOrganizationInput,
  ): Promise<ProvisionOrganizationResult> {
    if (actor.role !== UserRole.SUPERADMIN) {
      throw new ForbiddenException("Somente superadmin pode provisionar hospitais");
    }

    const name = input.name.trim();
    const timezone = input.timezone.trim();
    const firstAdminEmail = input.firstAdminEmail.trim().toLowerCase();

    if (name.length < 2) {
      throw new BadRequestException("Nome do hospital deve ter ao menos 2 caracteres");
    }
    if (!isValidIanaTimezone(timezone)) {
      throw new BadRequestException(`Timezone IANA inválida: ${input.timezone}`);
    }
    if (!EMAIL_PATTERN.test(firstAdminEmail)) {
      throw new BadRequestException("Email do primeiro administrador é inválido");
    }

    const existing = await this.prisma.user.findUnique({ where: { email: firstAdminEmail } });
    if (existing) {
      throw new BadRequestException("Já existe um usuário com este email");
    }

    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({ data: { name, timezone } });

      // audit_logs tem RLS; a organização acabou de nascer nesta
      // mesma transação, então o tenant só pode ser estabelecido
      // agora que o id existe (bootstrapping do primeiro registro).
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${organization.id}, true)`;

      const invitedAdmin = await tx.user.create({
        data: {
          oidcSubject: `pending:${randomUUID()}`,
          email: firstAdminEmail,
          role: UserRole.HOSPITAL_ADMIN,
          organizationId: organization.id,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: organization.id,
          actorUserId: actor.id,
          action: "organization.provisioned",
          targetType: "Organization",
          targetId: organization.id,
          justification: `Hospital "${name}" provisionado; primeiro admin convidado: ${firstAdminEmail}`,
        },
      });

      return { organizationId: organization.id, invitedAdminUserId: invitedAdmin.id };
    });
  }
}

function isValidIanaTimezone(timezone: string): boolean {
  if (!timezone) {
    return false;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
