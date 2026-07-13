import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Lista todos os hospitais para o SUPERADMIN (E-2, T-2.1.1).
 *
 * "organizations" NÃO tem RLS (é a raiz do tenant, não dado
 * tenant-scoped -- ver rls_and_constraints/migration.sql, que aplica
 * tenant_isolation só a credentials/shifts/applications/notifications
 * /audit_logs). Por isso este findMany() é trivial: não passa por
 * TenantContextService.withTenantScope, que existe para escopar
 * dados HOSPITALARES a um organization_id, não para listar hospitais
 * em si.
 */
@Injectable()
export class ListOrganizationsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute() {
    return this.prisma.organization.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, city: true, address: true },
    });
  }
}
