import { PrismaClient } from "@prisma/client";

/**
 * Conexão privilegiada usada SOMENTE em limpeza de fixtures de
 * teste (ex.: apagar audit_logs, que é imutável para a role de
 * runtime da aplicação por design — ver migration
 * audit_log_immutable). Nunca usar fora de afterAll/afterEach.
 */
export function createAdminPrismaForTestCleanup(): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: { url: "postgresql://postgres:athena_dev_local@localhost:5432/plantoes_medicos?schema=public" },
    },
  });
}
