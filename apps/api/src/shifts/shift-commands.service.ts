import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ShiftStatus, UserRole } from "@prisma/client";
import { TenantContextService } from "../organizations/tenant-context";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import { OutboxService } from "../notifications/outbox.service";

export interface DraftShiftInput {
  specialty: string;
  valueCents: number;
  startsAt: string;
  endsAt: string;
}

export interface EditShiftInput {
  specialty?: string;
  valueCents?: number;
  startsAt?: string;
  endsAt?: string;
}

/** Transições válidas de estado do plantão. */
const VALID_TRANSITIONS: Record<ShiftStatus, ShiftStatus[]> = {
  DRAFT: [ShiftStatus.PUBLISHED, ShiftStatus.CANCELLED],
  PUBLISHED: [ShiftStatus.FILLED, ShiftStatus.CANCELLED],
  FILLED: [],
  CANCELLED: [],
};

/**
 * ISO-8601 UTC explícito: exige designador de fuso ("Z" ou
 * +HH:mm/-HH:mm) para nunca depender de fuso implícito do servidor.
 * O timezone IANA de exibição vem de Organization.timezone; o
 * armazenamento é sempre o instante UTC.
 */
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function parseUtcDate(value: string, field: string): Date {
  if (!ISO_UTC_PATTERN.test(value)) {
    throw new BadRequestException(`${field} deve ser ISO-8601 com timezone explícito (ex.: 2026-08-01T08:00:00Z)`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} não é uma data válida`);
  }
  return date;
}

function validateValueCents(valueCents: number): void {
  if (!Number.isInteger(valueCents) || valueCents <= 0) {
    throw new BadRequestException("valueCents deve ser um inteiro positivo (centavos, nunca float)");
  }
}

/**
 * Quatro comandos de plantão: rascunhar (draft), publicar, editar e
 * cancelar. Máquina de estados explícita
 * (DRAFT -> PUBLISHED -> FILLED|CANCELLED; DRAFT -> CANCELLED
 * também permitido). "filled" só é atingido pela aprovação de
 * candidatura (E-4, fora do escopo destes comandos). Sempre
 * restrito ao hospital_admin do hospital dono do plantão.
 */
@Injectable()
export class ShiftCommandsService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly outbox: OutboxService,
  ) {}

  private requireAdmin(actor: AuthenticatedUser): string {
    if (actor.role !== UserRole.HOSPITAL_ADMIN) {
      throw new ForbiddenException("Somente hospital_admin gerencia plantões");
    }
    return this.tenantContext.requireHospitalOrganizationId(actor);
  }

  async draftShift(actor: AuthenticatedUser, input: DraftShiftInput) {
    const organizationId = this.requireAdmin(actor);

    if (!input.specialty || input.specialty.trim().length === 0) {
      throw new BadRequestException("specialty é obrigatória");
    }
    validateValueCents(input.valueCents);
    const startsAt = parseUtcDate(input.startsAt, "startsAt");
    const endsAt = parseUtcDate(input.endsAt, "endsAt");
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException("endsAt deve ser posterior a startsAt");
    }

    return this.tenantContext.withTenantScope(organizationId, (tx) =>
      tx.shift.create({
        data: {
          organizationId,
          specialty: input.specialty.trim(),
          valueCents: input.valueCents,
          startsAt,
          endsAt,
          status: ShiftStatus.DRAFT,
          createdByUserId: actor.id,
        },
      }),
    );
  }

  async editShift(actor: AuthenticatedUser, shiftId: string, input: EditShiftInput) {
    const organizationId = this.requireAdmin(actor);

    if (input.valueCents !== undefined) {
      validateValueCents(input.valueCents);
    }
    let startsAt: Date | undefined;
    let endsAt: Date | undefined;
    if (input.startsAt !== undefined) {
      startsAt = parseUtcDate(input.startsAt, "startsAt");
    }
    if (input.endsAt !== undefined) {
      endsAt = parseUtcDate(input.endsAt, "endsAt");
    }

    return this.tenantContext.withTenantScope(organizationId, async (tx) => {
      const existing = await tx.shift.findUnique({ where: { id: shiftId } });
      if (!existing) {
        throw new NotFoundException("Plantão não encontrado");
      }
      this.tenantContext.assertResourceBelongsToOrganization(existing.organizationId, organizationId);

      if (existing.status === ShiftStatus.FILLED || existing.status === ShiftStatus.CANCELLED) {
        throw new BadRequestException(`Plantão em estado ${existing.status} não pode ser editado`);
      }

      const nextStartsAt = startsAt ?? existing.startsAt;
      const nextEndsAt = endsAt ?? existing.endsAt;
      if (nextEndsAt.getTime() <= nextStartsAt.getTime()) {
        throw new BadRequestException("endsAt deve ser posterior a startsAt");
      }

      return tx.shift.update({
        where: { id: shiftId },
        data: {
          specialty: input.specialty?.trim(),
          valueCents: input.valueCents,
          startsAt,
          endsAt,
        },
      });
    });
  }

  async publishShift(actor: AuthenticatedUser, shiftId: string) {
    return this.transition(actor, shiftId, ShiftStatus.PUBLISHED);
  }

  async cancelShift(actor: AuthenticatedUser, shiftId: string) {
    return this.transition(actor, shiftId, ShiftStatus.CANCELLED);
  }

  private async transition(actor: AuthenticatedUser, shiftId: string, next: ShiftStatus) {
    const organizationId = this.requireAdmin(actor);

    return this.tenantContext.withTenantScope(organizationId, async (tx) => {
      const existing = await tx.shift.findUnique({ where: { id: shiftId } });
      if (!existing) {
        throw new NotFoundException("Plantão não encontrado");
      }
      this.tenantContext.assertResourceBelongsToOrganization(existing.organizationId, organizationId);

      const allowed = VALID_TRANSITIONS[existing.status];
      if (!allowed.includes(next)) {
        throw new BadRequestException(`Transição inválida: ${existing.status} -> ${next}`);
      }

      const updated = await tx.shift.update({ where: { id: shiftId }, data: { status: next } });

      if (next === ShiftStatus.PUBLISHED) {
        // Mesma transação do UPDATE: se o evento falhar ao gravar, a
        // publicação também sofre rollback — nunca ficam dessincronizados.
        await this.outbox.enqueue(tx, organizationId, "shift.published", {
          version: 1,
          shiftId: updated.id,
          specialty: updated.specialty,
        });
      }

      return updated;
    });
  }
}
