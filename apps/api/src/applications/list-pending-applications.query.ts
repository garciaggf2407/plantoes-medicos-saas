import { ForbiddenException, Injectable } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { TenantContextService } from "../organizations/tenant-context";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";

/**
 * Fila de candidaturas PENDING do hospital ativo do admin, para a
 * tela de revisão. Minimização de PII: retorna só o necessário para
 * decidir (especialidade/valor/horário do plantão, CRM e
 * especialidades do médico, email para identificação) — nunca
 * evidência de credencial nem telefone.
 */
@Injectable()
export class ListPendingApplicationsQuery {
  constructor(private readonly tenantContext: TenantContextService) {}

  async execute(actor: AuthenticatedUser) {
    if (actor.role !== UserRole.HOSPITAL_ADMIN) {
      throw new ForbiddenException("Somente hospital_admin acessa a fila de revisão");
    }
    const organizationId = this.tenantContext.requireHospitalOrganizationId(actor);

    return this.tenantContext.withTenantScope(organizationId, (tx) =>
      tx.application.findMany({
        where: { organizationId, status: "PENDING" },
        orderBy: [{ appliedAt: "asc" }],
        select: {
          id: true,
          appliedAt: true,
          shift: { select: { id: true, specialty: true, valueCents: true, startsAt: true, endsAt: true } },
          doctorProfile: {
            select: { crmNumber: true, specialties: true, user: { select: { email: true } } },
          },
        },
      }),
    );
  }
}
