import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { ApplicationStatus, UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../organizations/tenant-context";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";

export interface CalendarQueryInput {
  from: string;
  to: string;
}

export interface CalendarEvent {
  shiftId: string;
  specialty: string;
  valueCents: number;
  startsAt: Date;
  endsAt: Date;
  organizationId: string;
  organizationName: string;
  /** Timezone IANA do hospital, para o cliente converter o instante UTC para exibição local. */
  timezone: string;
}

function parseUtcDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} não é uma data válida`);
  }
  return date;
}

/**
 * Consulta de calendário do médico autenticado: plantões APROVADOS
 * dentro de um intervalo, agregados de QUALQUER hospital onde o
 * médico atua (ver política doctor_self_calendar). O instante fica
 * sempre armazenado e retornado em UTC; o timezone IANA do hospital
 * vem anexado em cada evento para conversão de exibição no cliente
 * — nunca convertido no servidor.
 */
@Injectable()
export class CalendarQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(actor: AuthenticatedUser, input: CalendarQueryInput): Promise<CalendarEvent[]> {
    if (actor.role !== UserRole.DOCTOR) {
      throw new ForbiddenException("Somente médico consulta o próprio calendário");
    }

    const from = parseUtcDate(input.from, "from");
    const to = parseUtcDate(input.to, "to");
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException("from não pode ser posterior a to");
    }

    const profile = await this.prisma.doctorProfile.findUnique({ where: { userId: actor.id } });
    if (!profile) {
      return [];
    }

    const applications = await this.tenantContext.withDoctorCalendarScope(profile.id, (tx) =>
      tx.application.findMany({
        where: {
          doctorProfileId: profile.id,
          status: ApplicationStatus.APPROVED,
          shift: { startsAt: { lt: to }, endsAt: { gt: from } },
        },
        include: { shift: { include: { organization: true } } },
        orderBy: [{ shift: { startsAt: "asc" } }, { id: "asc" }],
      }),
    );

    return applications.map((application) => ({
      shiftId: application.shift.id,
      specialty: application.shift.specialty,
      valueCents: application.shift.valueCents,
      startsAt: application.shift.startsAt,
      endsAt: application.shift.endsAt,
      organizationId: application.shift.organizationId,
      organizationName: application.shift.organization.name,
      timezone: application.shift.organization.timezone,
    }));
  }
}
