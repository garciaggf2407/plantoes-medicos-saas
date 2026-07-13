import { Injectable, NotFoundException } from "@nestjs/common";
import { TenantContextService } from "./tenant-context";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";

const DOCTOR_SUMMARY_SELECT = {
  crmNumber: true,
  specialties: true,
  user: { select: { email: true } },
} as const;

/**
 * Detalhe operacional (profile + plantões + candidaturas + credenciais)
 * de UM hospital, para o SUPERADMIN (E-2, T-2.1.1). Só leitura -- nenhum
 * método de escrita existe aqui nem é planejado para este caso de uso.
 *
 * organizationId é aceito aqui como PARÂMETRO EXPLÍCITO, ao contrário de
 * GetOrganizationProfileUseCase (hospital_admin), que nunca aceita um id
 * externo e sempre resolve o tenant da própria sessão autenticada. Essa
 * é uma exceção documentada e deliberada: o SUPERADMIN precisa poder
 * escolher QUAL hospital ver, e essa escolha só é segura porque a rota
 * que chama este caso de uso é restrita por @Roles(UserRole.SUPERADMIN)
 * na camada do controller (organizations.controller.ts) -- nenhum outro
 * papel alcança este código, e withTenantScope abaixo garante que só
 * linhas do organizationId pedido retornam (defesa em profundidade via
 * RLS, mesmo que a query tenha algum erro de digitação em outro campo).
 */
@Injectable()
export class GetOrganizationDetailUseCase {
  constructor(private readonly tenantContext: TenantContextService) {}

  async execute(actor: AuthenticatedUser, organizationId: string) {
    return this.tenantContext.withTenantScope(organizationId, async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { name: true, timezone: true, city: true, address: true, description: true, photoUrl: true },
      });
      if (!organization) {
        throw new NotFoundException("Hospital não encontrado");
      }

      const [shifts, applications, credentials] = await Promise.all([
        // Mesmo padrão de SearchShiftsQuery.listForAdmin: TODOS os
        // status (DRAFT/PUBLISHED/FILLED/CANCELLED), não só PUBLISHED.
        tx.shift.findMany({
          where: { organizationId },
          orderBy: [{ startsAt: "asc" }, { id: "asc" }],
          select: { id: true, specialty: true, valueCents: true, startsAt: true, endsAt: true, status: true },
        }),
        // TODAS as candidaturas (não só PENDING, ao contrário de
        // ListPendingApplicationsQuery) -- visibilidade operacional
        // completa para o superadmin.
        tx.application.findMany({
          where: { organizationId },
          orderBy: [{ appliedAt: "asc" }],
          select: {
            id: true,
            status: true,
            appliedAt: true,
            decidedAt: true,
            shift: { select: { id: true, specialty: true, valueCents: true, startsAt: true, endsAt: true } },
            doctorProfile: { select: DOCTOR_SUMMARY_SELECT },
          },
        }),
        // TODAS as credenciais (não só PENDING). Minimização de PII
        // preservada: nunca inclui evidenceUrl na listagem, mesma
        // disciplina de CredentialsService.listPendingForAdmin.
        tx.credential.findMany({
          where: { organizationId },
          orderBy: [{ createdAt: "asc" }],
          select: {
            id: true,
            status: true,
            createdAt: true,
            doctorProfile: { select: DOCTOR_SUMMARY_SELECT },
          },
        }),
      ]);

      // DP-1: cada leitura de detalhe cross-tenant do superadmin é
      // auditada, gravada NA MESMA transação da leitura -- nunca uma
      // escrita separada que possa falhar silenciosamente depois de já
      // ter servido os dados ao cliente (mesma disciplina de
      // ProvisionOrganizationUseCase).
      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: actor.id,
          action: "organization.viewed_by_superadmin",
          targetType: "Organization",
          targetId: organizationId,
          justification: `Superadmin visualizou o detalhe operacional do hospital ${organizationId}`,
        },
      });

      return { id: organizationId, ...organization, shifts, applications, credentials };
    });
  }
}
