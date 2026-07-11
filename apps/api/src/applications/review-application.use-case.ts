import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, ApplicationStatus, ShiftStatus, UserRole } from "@prisma/client";
import { TenantContextService } from "../organizations/tenant-context";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import { OutboxService } from "../notifications/outbox.service";
import { telemetry, withSpan } from "../observability/telemetry";
import { logEvent } from "../observability/structured-logger";

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
 * Se duas decisões concorrentes disputam o mesmo plantão, a segunda
 * transação a tentar seu UPDATE em "applications" recebe violação de
 * constraint do Postgres; este caso é traduzido em ConflictException.
 * Um `SELECT ... FOR UPDATE` na linha do plantão, logo no início da
 * transação, serializa essas decisões concorrentes ANTES de qualquer
 * UPDATE em applications — sem essa trava explícita, duas decisões
 * concorrentes no mesmo plantão podem formar um deadlock real do
 * Postgres (ShareLock cruzado via FK) em vez de uma violação de
 * constraint limpa. Ver comentário no início de execute().
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

    return withSpan(
      "application.decide",
      { "application.organization_id": organizationId, "application.id": applicationId, "application.decision": input.decision },
      async () => this.doExecute(actor, applicationId, input, organizationId, justification),
    );
  }

  private async doExecute(
    actor: AuthenticatedUser,
    applicationId: string,
    input: ReviewApplicationInput,
    organizationId: string,
    justification: string,
  ) {
    return this.tenantContext.withTenantScope(organizationId, async (tx) => {
      const preliminary = await tx.application.findUnique({ where: { id: applicationId } });
      if (!preliminary) {
        throw new NotFoundException("Candidatura não encontrada");
      }
      this.tenantContext.assertResourceBelongsToOrganization(preliminary.organizationId, organizationId);

      // Trava a linha do plantão ANTES de qualquer UPDATE em
      // applications deste plantão, estabelecendo uma ordem de lock
      // consistente entre decisões concorrentes (aprovar/rejeitar) do
      // MESMO plantão. Sem isso, duas decisões concorrentes podem
      // formar um deadlock real do Postgres: um UPDATE em
      // "applications" dispara um ShareLock implícito na linha do
      // shift referenciado (checagem de FK), então cada transação
      // fica presa esperando a outra liberar esse ShareLock antes de
      // conseguir a trava exclusiva do próprio UPDATE em "shifts"
      // mais adiante — um ciclo clássico de espera cruzada. Travar o
      // shift primeiro faz a segunda transação simplesmente esperar
      // em fila em vez de formar o ciclo.
      await tx.$queryRaw`SELECT id FROM shifts WHERE id = ${preliminary.shiftId} FOR UPDATE`;

      // Re-lê a candidatura já com o plantão travado — garante ver o
      // estado mais atual (ex.: se uma decisão concorrente para o
      // mesmo plantão já rodou e auto-rejeitou esta candidatura
      // enquanto esperávamos a trava).
      const application = await tx.application.findUnique({ where: { id: applicationId } });
      if (!application) {
        throw new NotFoundException("Candidatura não encontrada");
      }

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
        telemetry.decisionCounter.add(1, { "decision.kind": "application", "decision.outcome": "rejected" });
        logEvent("application.decide", { organizationId, applicationId, decision: "REJECTED" });
        return updated;
      }

      // Relê o plantão (já travado por FOR UPDATE acima) para garantir
      // que ele continua PUBLISHED antes de aprovar. Sem isso, uma
      // candidatura PENDING "órfã" (deixada para trás porque cancelar
      // um plantão não rejeitava suas candidaturas pendentes) podia
      // ser aprovada mesmo com o plantão já CANCELLED, revivendo-o
      // silenciosamente para FILLED — uma transição fora da máquina de
      // estados de ShiftCommandsService. Bug real encontrado em
      // auditoria; ver .planning/STATE.md.
      const shift = await tx.shift.findUnique({ where: { id: application.shiftId } });
      if (!shift || shift.status !== ShiftStatus.PUBLISHED) {
        throw new ConflictException({
          error: "shift_not_available",
          message: "Este plantão não está mais disponível para aprovação",
        });
      }

      // Conflito de agenda: a checagem em apply-to-shift.use-case.ts só
      // olha candidaturas já APROVADAS no momento da candidatura. Duas
      // candidaturas PENDING para plantões sobrepostos passam essa
      // checagem (nenhuma delas é APPROVED ainda) e só colidiriam se
      // reverificadas aqui, no momento da decisão -- sem isso, um
      // médico pode ser aprovado para dois plantões com o mesmo
      // horário. Bug real encontrado em auditoria.
      const overlapping = await tx.application.findFirst({
        where: {
          doctorProfileId: application.doctorProfileId,
          organizationId,
          status: ApplicationStatus.APPROVED,
          id: { not: applicationId },
          shift: { startsAt: { lt: shift.endsAt }, endsAt: { gt: shift.startsAt } },
        },
      });
      if (overlapping) {
        throw new ConflictException({
          error: "schedule_conflict",
          message: "Médico já possui outro plantão aprovado que conflita com este horário",
        });
      }

      // Credencial pode ter sido revogada/expirada depois da
      // candidatura (só era checada em apply-to-shift.use-case.ts, uma
      // única vez, no passado). Sem reconferir aqui, um médico com
      // credencial hoje inválida pode ser aprovado. Bug real
      // encontrado em auditoria.
      const credential = await tx.credential.findUnique({
        where: {
          doctorProfileId_organizationId: { doctorProfileId: application.doctorProfileId, organizationId },
        },
      });
      if (!credential || credential.status !== "APPROVED") {
        throw new ConflictException({
          error: "credential_not_approved",
          message: "Credencial do médico não está mais aprovada para este hospital",
        });
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

      telemetry.decisionCounter.add(1, { "decision.kind": "application", "decision.outcome": "approved" });
      logEvent("application.decide", { organizationId, applicationId, decision: "APPROVED" });

      return updated;
    });
  }
}
