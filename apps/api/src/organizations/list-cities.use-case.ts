import { Injectable } from "@nestjs/common";
import type { CityDto } from "@plantoes/shared";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Cidades com ao menos um hospital cadastrado. "organizations" não tem
 * RLS (é a raiz do tenant, não dado tenant-scoped -- ver nota de
 * refinamento em checkpoint-map.yaml), então esta é uma leitura direta
 * via PrismaService, sem TenantContextService.withTenantScope.
 *
 * Fonte única de verdade para:
 *  - GET /cities (esta classe)
 *  - Validação de DoctorProfile.city em CredentialsService (nunca texto
 *    livre -- só cidade com hospital real cadastrado)
 *  - Resolução dos organizationIds de uma cidade em
 *    SearchShiftsByCityQuery (busca multi-hospital)
 */
@Injectable()
export class ListCitiesUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(): Promise<CityDto[]> {
    const groups = await this.prisma.organization.groupBy({
      by: ["city"],
      where: { city: { not: null } },
      _count: { _all: true },
    });

    return groups
      .map((group) => ({ city: group.city as string, organizationCount: group._count._all }))
      .sort((a, b) => a.city.localeCompare(b.city));
  }

  /** organizationIds de hospitais na cidade informada (comparação exata -- city vem sempre de GET /cities, nunca digitado livre). */
  async organizationIdsForCity(city: string): Promise<string[]> {
    const organizations = await this.prisma.organization.findMany({
      where: { city },
      select: { id: true },
    });
    return organizations.map((organization) => organization.id);
  }

  /** Confirma se a cidade informada existe entre os hospitais cadastrados (usado na validação de perfil do médico). */
  async cityExists(city: string): Promise<boolean> {
    const match = await this.prisma.organization.findFirst({ where: { city }, select: { id: true } });
    return match !== null;
  }
}
