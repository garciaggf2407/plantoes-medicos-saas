import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { OrganizationProfileDto } from "@plantoes/shared";
import { TenantContextService } from "./tenant-context";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";

export type UpdateOrganizationProfileInput = Partial<
  Pick<OrganizationProfileDto, "city" | "address" | "description" | "photoUrl">
>;

const MAX_LENGTHS = { city: 120, address: 300, description: 2000 } as const;

function normalizeOptionalString(value: string | null, field: keyof typeof MAX_LENGTHS): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_LENGTHS[field]) {
    throw new BadRequestException(`${field} excede o tamanho máximo de ${MAX_LENGTHS[field]} caracteres`);
  }
  return trimmed;
}

function normalizePhotoUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BadRequestException("photoUrl deve ser uma URL válida");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestException("photoUrl deve usar http ou https");
  }
  return trimmed;
}

/**
 * Edição do perfil do PRÓPRIO hospital do hospital_admin autenticado
 * (BP-2026-07-12-001). organizationId sempre resolvido via
 * TenantContextService -- nunca aceito como input direto (ver R-1 em
 * exec-arch.yaml). Update parcial: campo AUSENTE do body não é
 * tocado; campo presente com string vazia limpa o valor (null).
 * Update + AuditLog gravados na mesma transação (audit_logs tem RLS,
 * por isso o uso de withTenantScope em vez de prisma direto).
 */
@Injectable()
export class UpdateOrganizationProfileUseCase {
  constructor(private readonly tenantContext: TenantContextService) {}

  async execute(
    actor: AuthenticatedUser,
    input: UpdateOrganizationProfileInput,
  ): Promise<OrganizationProfileDto> {
    const organizationId = this.tenantContext.requireHospitalOrganizationId(actor);

    const data: Prisma.OrganizationUpdateInput = {};
    const changedFields: string[] = [];

    if (Object.prototype.hasOwnProperty.call(input, "city")) {
      data.city = normalizeOptionalString(input.city ?? null, "city");
      changedFields.push("city");
    }
    if (Object.prototype.hasOwnProperty.call(input, "address")) {
      data.address = normalizeOptionalString(input.address ?? null, "address");
      changedFields.push("address");
    }
    if (Object.prototype.hasOwnProperty.call(input, "description")) {
      data.description = normalizeOptionalString(input.description ?? null, "description");
      changedFields.push("description");
    }
    if (Object.prototype.hasOwnProperty.call(input, "photoUrl")) {
      data.photoUrl = normalizePhotoUrl(input.photoUrl ?? null);
      changedFields.push("photoUrl");
    }

    return this.tenantContext.withTenantScope(organizationId, async (tx) => {
      const existing = await tx.organization.findUnique({ where: { id: organizationId } });
      if (!existing) {
        throw new NotFoundException("Hospital não encontrado");
      }

      const updated = await tx.organization.update({
        where: { id: organizationId },
        data,
        select: { name: true, timezone: true, city: true, address: true, description: true, photoUrl: true },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: actor.id,
          action: "organization.profile_updated",
          targetType: "Organization",
          targetId: organizationId,
          justification: `Campos alterados: ${changedFields.join(", ") || "nenhum"}`,
        },
      });

      return updated;
    });
  }
}
