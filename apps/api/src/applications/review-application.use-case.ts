import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, ApplicationStatus, ShiftStatus, UserRole } from "@prisma/client";
import { TenantContextService } from "../organizations/tenant-context";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import { OutboxService } from "../notifications/outbox.service";

export type ApplicationDecision = "APPROVED" | "REJECTED";

export interface ReviewApplicationInput {
  organizationId: string;
  decision: ApplicationDecision;
  justification: string;
}

/**
 * Decisão administrativa sobre uma candidatura: aprova ou rejeita.
 * Somente hospital_admin do hospital vinculado decide.
 *
 * Garantia de concorrência (SC-5): um plantão nunca pode ter duas
 * candidaturas aprovadas ao mesmo tempo. A garantia real é o índice
 * único parcial `applications_one_approved_per_shift` no banco
 * (migration rls_and_constraints, T-1.1.3) — não uma checagem em
 * código, que teria uma janela de corrida entre "ler" e "escrever".
 * Se duas aprovações concorrentes disputam o mesmo plantão, a
 * segunda transação a tentar o COMMIT recebe violação de constraint
 * do Postgres; este caso é traduzido em ConflictException.
 *
 * Ao aprovar, o plantão muda para FILLED e qualquer outra
 * candidatura PENDING para o mesmo plantão é auto-rejeitada (o
 * plantão não está mais disponível).
 */
@Injectable()
export class ReviewApplicationUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(actor: AuthenticatedUser, applicationId: string, input: ReviewApplicationInput) {
    if (actor.role !== UserRole.HOSPITAL_ADMIN) {
      throw new ForbiddenException("Somente hospital_admin decide sobre candidaturas");
    }
    const organizationId = this.tenantContext.requireHospitalOrganizationId(actor);
    this.tenantContext.assertResourceBelongsToOrganization(input.organizationId, organizationId);

    const justification = input.justification?.trim();
    if (!justification || justification.length < 5) {
      throw new BadRequestException("justification deve ter ao menos 5 caracteres");
    }

    return this.tenantContext.withTenantScope(organizationId, async (tx) => {
      const application = await tx.application.findUnique({ where: { id: applicationId } });
      if (!application) {
        throw new NotFoundException("Candidatura não encontrada");
      }
      this.tenantContext.assertResourceBelongsToOrganization(application.organizationId, organizationId);

      if (application.status !== ApplicationStatus.PENDING) {
        if (application.status === input.decision) {
          // Reenvio idempotente da mesma decisão: no-op.
          return application;
        }
        throw new BadRequestException(
          `Transição inválida: ${application.status} -> ${input.decision}`,
        );
      }

      if (input.decision === "REJECTED") {
        const updated = await tx.application.update({
          where: { id: applicationId },
          data: { status: ApplicationStatus.REJECTED, decidedByUserId: actor.id, decidedAt: new Date(), justification },
        });
        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: actor.id,
            action: "application.rejected",
            targetType: "Application",
            targetId: applicationId,
            justification,
          },
        });
        await this.outbox.enqueue(tx, organizationId, "application.decided", {
          version: 1,
          applicationId: updated.id,
          shiftId: application.shiftId,
          doctorProfileId: application.doctorProfileId,
          decision: "REJECTED",
        });
        return updated;
      }

      let updated;
      try {
        updated = await tx.application.update({
          where: { id: applicationId },
          data: { status: ApplicationStatus.APPROVED, decidedByUserId: actor.id, decidedAt: new Date(), justification },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new ConflictException({
            error: "shift_already_filled",
            message: "Este plantão já foi aprovado para outro médico",
          });
        }
        throw error;
      }

      await tx.shift.update({ where: { id: application.shiftId }, data: { status: ShiftStatus.FILLED } });

      await tx.application.updateMany({
        where: { shiftId: application.shiftId, status: ApplicationStatus.PENDING, id: { not: applicationId } },
        data: {
          status: ApplicationStatus.REJECTED,
          decidedByUserId: actor.id,
          decidedAt: new Date(),
          justification: "Plantão preenchido por outro candidato",
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: actor.id,
          action: "application.approved",
          targetType: "Application",
          targetId: applicationId,
          justification,
        },
      });

      await this.outbox.enqueue(tx, organizationId, "application.decided", {
        version: 1,
        applicationId: updated.id,
        shiftId: application.shiftId,
        doctorProfileId: application.doctorProfileId,
        decision: "APPROVED",
      });

      return updated;
    });
  }
}
