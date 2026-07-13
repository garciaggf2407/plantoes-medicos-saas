import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../organizations/tenant-context";
import { ListCitiesUseCase } from "../organizations/list-cities.use-case";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";

export interface DoctorProfileInput {
  crmNumber: string;
  specialties: string[];
  contactPhone?: string;
  /**
   * Cidade de preferência do médico -- sempre validada contra
   * Organization.city já cadastradas (nunca texto livre, evita
   * "Campinas" vs "campinas" vs "Campinas-SP" como cidades distintas).
   * Filtro de conveniência para a busca de plantões, nunca uma trava.
   */
  city?: string;
}

export interface SubmitCredentialInput {
  organizationId: string;
  evidenceUrl: string;
}

const PHONE_PATTERN = /^\+?[0-9\s()-]{8,20}$/;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validateDoctorProfileInput(input: DoctorProfileInput): void {
  if (!input.crmNumber || input.crmNumber.trim().length < 3) {
    throw new BadRequestException("crmNumber deve ter ao menos 3 caracteres");
  }
  if (!Array.isArray(input.specialties) || input.specialties.length === 0) {
    throw new BadRequestException("specialties deve conter ao menos uma especialidade");
  }
  if (input.specialties.some((s) => typeof s !== "string" || s.trim().length === 0)) {
    throw new BadRequestException("specialties não pode conter valores vazios");
  }
  if (input.contactPhone !== undefined && !PHONE_PATTERN.test(input.contactPhone)) {
    throw new BadRequestException("contactPhone em formato inválido");
  }
  if (input.city !== undefined && input.city.trim().length === 0) {
    throw new BadRequestException("city não pode ser vazia quando enviada");
  }
}

/**
 * Perfil do médico (especialidades, contato, CRM) e submissão de
 * evidência de credencial por hospital. Acesso sempre restrito ao
 * próprio médico dono do perfil — nunca a outro médico — e, para
 * leitura de credencial, também ao hospital_admin do hospital
 * vinculado (ver getCredential).
 */
@Injectable()
export class CredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly listCities: ListCitiesUseCase,
  ) {}

  async upsertOwnProfile(actor: AuthenticatedUser, input: DoctorProfileInput) {
    if (actor.role !== UserRole.DOCTOR) {
      throw new ForbiddenException("Somente médico altera o próprio perfil");
    }
    validateDoctorProfileInput(input);

    const city = input.city?.trim();
    if (city !== undefined) {
      const exists = await this.listCities.cityExists(city);
      if (!exists) {
        throw new BadRequestException("city informada não corresponde a nenhum hospital cadastrado (ver GET /cities)");
      }
    }

    const data = {
      crmNumber: input.crmNumber.trim(),
      specialties: input.specialties.map((s) => s.trim()),
      contactPhone: input.contactPhone?.trim(),
      city,
    };

    return this.tenantContext.withSelfAuthoredAudit(actor.id, async (tx) => {
      const existing = await tx.doctorProfile.findUnique({ where: { userId: actor.id } });
      const profile = existing
        ? await tx.doctorProfile.update({ where: { userId: actor.id }, data })
        : await tx.doctorProfile.create({ data: { ...data, userId: actor.id } });

      await tx.auditLog.create({
        data: {
          organizationId: null,
          actorUserId: actor.id,
          action: existing ? "doctor_profile.updated" : "doctor_profile.created",
          targetType: "DoctorProfile",
          targetId: profile.id,
          justification: "Médico alterou o próprio perfil",
        },
      });

      return profile;
    });
  }

  async getOwnProfile(actor: AuthenticatedUser) {
    if (actor.role !== UserRole.DOCTOR) {
      throw new ForbiddenException("Somente médico acessa o próprio perfil por esta rota");
    }
    return this.prisma.doctorProfile.findUnique({ where: { userId: actor.id } });
  }

  async submitCredential(actor: AuthenticatedUser, input: SubmitCredentialInput) {
    if (actor.role !== UserRole.DOCTOR) {
      throw new ForbiddenException("Somente médico envia evidência de credencial");
    }
    if (!isHttpUrl(input.evidenceUrl)) {
      throw new BadRequestException("evidenceUrl deve ser uma URL http(s) válida");
    }

    const profile = await this.prisma.doctorProfile.findUnique({ where: { userId: actor.id } });
    if (!profile) {
      throw new BadRequestException("Crie o perfil médico antes de enviar uma credencial");
    }

    const organization = await this.prisma.organization.findUnique({ where: { id: input.organizationId } });
    if (!organization) {
      throw new BadRequestException("Hospital informado não existe");
    }

    return this.tenantContext.withTenantScope(input.organizationId, (tx) =>
      tx.credential.upsert({
        where: {
          doctorProfileId_organizationId: {
            doctorProfileId: profile.id,
            organizationId: input.organizationId,
          },
        },
        create: {
          doctorProfileId: profile.id,
          organizationId: input.organizationId,
          evidenceUrl: input.evidenceUrl,
        },
        update: {
          evidenceUrl: input.evidenceUrl,
          status: "PENDING",
          reviewedByUserId: null,
          reviewedAt: null,
          justification: null,
        },
      }),
    );
  }

  /**
   * Leitura de uma credencial específica. organizationId é exigido
   * explicitamente (não inferido) para poder abrir o escopo de
   * tenant correto sob RLS antes mesmo de saber o conteúdo da linha;
   * o acesso real ainda é verificado depois, no servidor.
   */
  async getCredential(actor: AuthenticatedUser, credentialId: string, organizationId: string) {
    const credential = await this.tenantContext.withTenantScope(organizationId, (tx) =>
      tx.credential.findUnique({
        where: { id: credentialId },
        include: { doctorProfile: true },
      }),
    );
    if (!credential) {
      throw new NotFoundException("Credencial não encontrada");
    }
    this.tenantContext.assertResourceBelongsToOrganization(credential.organizationId, organizationId);

    const isOwner = actor.role === UserRole.DOCTOR && credential.doctorProfile.userId === actor.id;
    const isAuthorizedAdmin =
      actor.role === UserRole.HOSPITAL_ADMIN && actor.organizationId === credential.organizationId;
    if (!isOwner && !isAuthorizedAdmin) {
      throw new ForbiddenException("Evidência de CRM só é visível ao médico dono e ao admin do hospital vinculado");
    }

    return credential;
  }

  /**
   * Fila de credenciais PENDING do hospital ativo do admin, para a
   * tela de revisão. Minimização de PII: não inclui evidenceUrl nem
   * contactPhone na listagem — só o necessário para triagem (CRM,
   * especialidades, email para identificação). O admin abre
   * getCredential(id) quando precisa ver a evidência de verdade.
   */
  async listPendingForAdmin(actor: AuthenticatedUser) {
    if (actor.role !== UserRole.HOSPITAL_ADMIN) {
      throw new ForbiddenException("Somente hospital_admin acessa a fila de revisão");
    }
    const organizationId = this.tenantContext.requireHospitalOrganizationId(actor);

    return this.tenantContext.withTenantScope(organizationId, (tx) =>
      tx.credential.findMany({
        where: { organizationId, status: "PENDING" },
        orderBy: [{ createdAt: "asc" }],
        select: {
          id: true,
          createdAt: true,
          doctorProfile: {
            select: { crmNumber: true, specialties: true, user: { select: { email: true } } },
          },
        },
      }),
    );
  }
}
