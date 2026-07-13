import { Injectable, NotFoundException } from "@nestjs/common";
import type { OrganizationProfileDto } from "@plantoes/shared";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "./tenant-context";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";

/**
 * Leitura do perfil do PRÓPRIO hospital do hospital_admin autenticado.
 * organizationId nunca vem de input do cliente -- sempre resolvido via
 * TenantContextService a partir da sessão (BP-2026-07-12-001).
 */
@Injectable()
export class GetOrganizationProfileUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(actor: AuthenticatedUser): Promise<OrganizationProfileDto> {
    const organizationId = this.tenantContext.requireHospitalOrganizationId(actor);
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, timezone: true, city: true, address: true, description: true, photoUrl: true },
    });
    if (!organization) {
      throw new NotFoundException("Hospital não encontrado");
    }
    return organization;
  }
}
