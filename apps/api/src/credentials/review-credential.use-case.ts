import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { CredentialStatus, UserRole } from "@prisma/client";
import { TenantContextService } from "../organizations/tenant-context";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";

export type CredentialDecision = "APPROVED" | "REJECTED" | "EXPIRED";

export interface ReviewCredentialInput {
  organizationId: string;
  decision: CredentialDecision;
  justification: string;
}

/** Transições válidas de estado. Qualquer combinação fora deste mapa é rejeitada. */
const VALID_TRANSITIONS: Record<CredentialStatus, CredentialDecision[]> = {
  PENDING: ["APPROVED", "REJECTED"],
  APPROVED: ["EXPIRED"],
  REJECTED: [],
  EXPIRED: [],
};

/**
 * Caso de uso administrativo: aprova, rejeita ou expira uma
 * credencial médica. Somente o hospital_admin do hospital vinculado
 * à credencial decide — nunca outro hospital, nunca outro papel.
 * Toda decisão exige justificativa textual e gera evento de
 * auditoria com ator e timestamp, na mesma transação da mudança de
 * estado. audit_logs é imutável no banco (sem UPDATE/DELETE para a
 * role de runtime — ver migration audit_log_immutable).
 */
@Injectable()
export class ReviewCredentialUseCase {
  constructor(private readonly tenantContext: TenantContextService) {}

  async execute(actor: AuthenticatedUser, credentialId: string, input: ReviewCredentialInput) {
    if (actor.role !== UserRole.HOSPITAL_ADMIN) {
      throw new ForbiddenException("Somente hospital_admin decide sobre credenciais");
    }
    const organizationId = this.tenantContext.requireHospitalOrganizationId(actor);
    this.tenantContext.assertResourceBelongsToOrganization(input.organizationId, organizationId);

    const justification = input.justification?.trim();
    if (!justification || justification.length < 5) {
      throw new BadRequestException("justification deve ter ao menos 5 caracteres");
    }

    return this.tenantContext.withTenantScope(organizationId, async (tx) => {
      const credential = await tx.credential.findUnique({ where: { id: credentialId } });
      if (!credential) {
        throw new NotFoundException("Credencial não encontrada");
      }
      this.tenantContext.assertResourceBelongsToOrganization(credential.organizationId, organizationId);

      const allowedNextStates = VALID_TRANSITIONS[credential.status];
      if (!allowedNextStates.includes(input.decision)) {
        throw new BadRequestException(
          `Transição inválida: ${credential.status} -> ${input.decision}`,
        );
      }

      const updated = await tx.credential.update({
        where: { id: credentialId },
        data: {
          status: input.decision,
          reviewedByUserId: actor.id,
          reviewedAt: new Date(),
          justification,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: actor.id,
          action: `credential.${input.decision.toLowerCase()}`,
          targetType: "Credential",
          targetId: credentialId,
          justification,
        },
      });

      return updated;
    });
  }
}
