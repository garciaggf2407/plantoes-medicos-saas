import { ForbiddenException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";

/**
 * Contexto de tenant obrigatório. organizationId nunca é lido de
 * body/query/header do request — sempre da sessão autenticada
 * (req.user, populado por AuthenticationGuard a partir do cookie
 * assinado) ou de um recurso já carregado e verificado no servidor.
 */
@Injectable()
export class TenantContextService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * organizationId de um hospital_admin. Falha fechada: lança
   * ForbiddenException se o usuário autenticado não tiver hospital
   * associado — não existe fallback para tenant global.
   */
  requireHospitalOrganizationId(user: AuthenticatedUser): string {
    if (!user.organizationId) {
      throw new ForbiddenException(
        "Usuário sem hospital associado — operação requer tenant resolvido, sem fallback global",
      );
    }
    return user.organizationId;
  }

  /**
   * Confirma que um recurso já carregado (ex.: um Shift buscado por
   * id) pertence ao organizationId esperado antes de qualquer efeito
   * colateral. Usado quando o tenant da operação vem do recurso
   * (ex.: candidatura de médico a um plantão de um hospital
   * específico), nunca de um campo enviado pelo cliente.
   */
  assertResourceBelongsToOrganization(
    resourceOrganizationId: string,
    expectedOrganizationId: string,
  ): void {
    if (resourceOrganizationId !== expectedOrganizationId) {
      throw new ForbiddenException("Recurso não pertence ao hospital esperado");
    }
  }

  /**
   * Executa `work` dentro de uma transação Prisma com a variável de
   * sessão do Postgres app.current_organization_id definida via
   * set_config (parametrizado — nunca por interpolação de string),
   * a mesma variável lida pelas políticas de RLS criadas em
   * rls_and_constraints. App e banco ficam sempre de acordo sobre o
   * tenant corrente da unidade de trabalho.
   *
   * Falha fechada: organizationId vazio/indefinido nunca chega a
   * abrir uma transação — a operação é rejeitada antes de tocar o
   * banco.
   */
  async withTenantScope<T>(
    organizationId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!organizationId) {
      throw new ForbiddenException("Tenant não resolvido — operação bloqueada (fail closed)");
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true)`;
      return work(tx);
    });
  }
}
