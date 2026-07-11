import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ApplicationStatus, ShiftStatus, UserRole } from "@prisma/client";
import { TenantContextService } from "../organizations/tenant-context";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import { telemetry, withSpan } from "../observability/telemetry";
import { logEvent } from "../observability/structured-logger";

export interface ApplyToShiftInput {
  shiftId: string;
  organizationId: string;
}

export class ApplicationRejectedError extends BadRequestException {
  constructor(public readonly reason: string, message: string) {
    super({ error: "application_rejected", reason, message });
  }
}

/**
 * Candidatura idempotente de um médico a um plantão. Toda a
 * validação roda dentro de uma única transação escopada ao tenant
 * do plantão:
 *  1. Plantão existe, pertence ao hospital informado e está
 *     PUBLISHED.
 *  2. Médico tem perfil e credencial APPROVED para este hospital.
 *  3. Especialidade do plantão é compatível com as do médico.
 *  4. Sem conflito de agenda com outra candidatura já APPROVED do
 *     médico NESTE MESMO hospital (limitação conhecida: RLS escopa
 *     uma transação a um tenant por vez, então conflito de agenda
 *     entre hospitais diferentes não é verificado aqui — exigiria
 *     um índice/serviço global de agenda do médico, fora do escopo
 *     desta task).
 *
 * Idempotência: reenviar a mesma candidatura (mesmo shiftId +
 * doctorProfileId) nunca cria uma segunda linha — a constraint
 * única @@unique([shiftId, doctorProfileId]) do banco garante isso
 * mesmo sob concorrência, não apenas a checagem em código.
 */
@Injectable()
export class ApplyToShiftUseCase {
  constructor(private readonly tenantContext: TenantContextService) {}

  async execute(actor: AuthenticatedUser, input: ApplyToShiftInput) {
    if (actor.role !== UserRole.DOCTOR) {
      throw new ForbiddenException("Somente médico se candidata a plantão");
    }

    return withSpan(
      "application.apply",
      { "application.organization_id": input.organizationId, "application.shift_id": input.shiftId },
      async () => this.doExecute(actor, input),
    );
  }

  private async doExecute(actor: AuthenticatedUser, input: ApplyToShiftInput) {
    return this.tenantContext.withTenantScope(input.organizationId, async (tx) => {
      const shift = await tx.shift.findUnique({ where: { id: input.shiftId } });
      if (!shift) {
        throw new NotFoundException("Plantão não encontrado");
      }
      this.tenantContext.assertResourceBelongsToOrganization(shift.organizationId, input.organizationId);

      if (shift.status !== ShiftStatus.PUBLISHED) {
        throw new ApplicationRejectedError("shift_not_published", "Plantão não está publicado");
      }

      const profile = await tx.doctorProfile.findUnique({ where: { userId: actor.id } });
      if (!profile) {
        throw new ApplicationRejectedError("profile_required", "Crie o perfil médico antes de se candidatar");
      }

      const existingApplication = await tx.application.findUnique({
        where: { shiftId_doctorProfileId: { shiftId: input.shiftId, doctorProfileId: profile.id } },
      });
      if (existingApplication && existingApplication.status !== ApplicationStatus.REJECTED) {
        // Reenvio idempotente: retorna a candidatura já existente sem duplicar.
        return existingApplication;
      }

      const credential = await tx.credential.findUnique({
        where: { doctorProfileId_organizationId: { doctorProfileId: profile.id, organizationId: input.organizationId } },
      });
      if (!credential || credential.status !== "APPROVED") {
        throw new ApplicationRejectedError("credential_not_approved", "Credencial não aprovada para este hospital");
      }

      const doctorSpecialties = profile.specialties.map((s) => s.toLowerCase());
      if (!doctorSpecialties.includes(shift.specialty.toLowerCase())) {
        throw new ApplicationRejectedError("specialty_mismatch", "Especialidade do médico não compatível com o plantão");
      }

      const conflicting = await tx.application.findFirst({
        where: {
          doctorProfileId: profile.id,
          organizationId: input.organizationId,
          status: ApplicationStatus.APPROVED,
          shift: {
            startsAt: { lt: shift.endsAt },
            endsAt: { gt: shift.startsAt },
          },
        },
      });
      if (conflicting) {
        throw new ApplicationRejectedError("schedule_conflict", "Conflito de agenda com outro plantão aprovado");
      }

      const result = await tx.application.upsert({
        where: { shiftId_doctorProfileId: { shiftId: input.shiftId, doctorProfileId: profile.id } },
        create: {
          shiftId: input.shiftId,
          doctorProfileId: profile.id,
          organizationId: input.organizationId,
          status: ApplicationStatus.PENDING,
        },
        update: {
          status: ApplicationStatus.PENDING,
          decidedAt: null,
          decidedByUserId: null,
          justification: null,
        },
      });

      telemetry.applicationCounter.add(1);
      logEvent("application.apply", { organizationId: input.organizationId, shiftId: input.shiftId, applicationId: result.id });

      return result;
    });
  }
}
