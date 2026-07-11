import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ApplicationStatus, ShiftStatus, UserRole } from "@prisma/client";
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
// Triado em reports/security-baseline.md: falso positivo do
// security/detect-unsafe-regex. Sem quantificadores
// aninhados/sobrepostos (o padrão real de ReDoS, ex. (a+)+$); todos
// os grupos são de comprimento fixo ({4}/{2}) exceto (\.\d+)?, um
// único grupo opcional não repetido -- pior caso é O(n), não
// exponencial.
// eslint-disable-next-line security/detect-unsafe-regex
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

      // Um plantão PUBLISHED com candidatura ativa (PENDING ou
      // APPROVED) não pode ter valor/horário/especialidade alterado
      // por baixo do médico que já se candidatou nesses termos --
      // isso mudaria silenciosamente o que ele viu ao se candidatar,
      // sem revalidação nem aviso. Bug real encontrado em auditoria;
      // a correção exige cancelar e recriar em vez de editar.
      if (existing.status === ShiftStatus.PUBLISHED) {
        const hasActiveApplication = await tx.application.findFirst({
          where: { shiftId, status: { in: [ApplicationStatus.PENDING, ApplicationStatus.APPROVED] } },
        });
        if (hasActiveApplication) {
          throw new BadRequestException(
            "Plantão publicado com candidatura ativa não pode ser editado — cancele e crie um novo plantão",
          );
        }
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
      const preliminary = await tx.shift.findUnique({ where: { id: shiftId } });
      if (!preliminary) {
        throw new NotFoundException("Plantão não encontrado");
      }
      this.tenantContext.assertResourceBelongsToOrganization(preliminary.organizationId, organizationId);

      // Trava a linha ANTES de reler o status. Sem isso, duas
      // requisições concorrentes de transição (ex.: publish duplo)
      // podem ambas ler o mesmo status de origem e ambas passarem em
      // VALID_TRANSITIONS, produzindo efeitos duplicados -- no caso de
      // publish, dois eventos shift.published distintos, cada um
      // disparando notificação/email duplicado para cada médico
      // compatível. Mesmo padrão de lock-ordering já usado em
      // ReviewApplicationUseCase. Bug real encontrado em auditoria.
      await tx.$queryRaw`SELECT id FROM shifts WHERE id = ${shiftId} FOR UPDATE`;

      const existing = await tx.shift.findUnique({ where: { id: shiftId } });
      if (!existing) {
        throw new NotFoundException("Plantão não encontrado");
      }

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

      if (next === ShiftStatus.CANCELLED) {
        // Cancelar um plantão publicado deixava candidaturas PENDING
        // órfãs: nunca eram rejeitadas, o médico nunca era avisado, e
        // uma aprovação tardia dessa candidatura conseguia ressuscitar
        // o plantão cancelado para FILLED (ver a checagem de
        // shift.status em ReviewApplicationUseCase). Bug real
        // encontrado em auditoria -- corrigido rejeitando toda
        // candidatura PENDING deste plantão, na mesma transação do
        // cancelamento, e notificando cada candidato via outbox.
        const pending = await tx.application.findMany({
          where: { shiftId, status: ApplicationStatus.PENDING },
          select: { id: true, doctorProfileId: true },
        });
        if (pending.length > 0) {
          await tx.application.updateMany({
            where: { shiftId, status: ApplicationStatus.PENDING },
            data: {
              status: ApplicationStatus.REJECTED,
              decidedByUserId: actor.id,
              decidedAt: new Date(),
              justification: "Plantão cancelado pelo hospital",
            },
          });
          for (const application of pending) {
            await this.outbox.enqueue(tx, organizationId, "application.decided", {
              version: 1,
              applicationId: application.id,
              shiftId,
              doctorProfileId: application.doctorProfileId,
              decision: "REJECTED",
            });
          }
        }
      }

      return updated;
    });
  }
}
