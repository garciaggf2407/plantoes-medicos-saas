import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { TenantContextService } from "../../src/organizations/tenant-context";
import type { AuthenticatedUser } from "../../src/identity/guards/authentication.guard";

process.env.SESSION_SECRET ??= "test-only-session-secret-32-characters";
process.env.OIDC_ISSUER_URL = "";
// A aplicação (e estes testes) devem rodar SEMPRE com a role restrita
// — se este teste usasse o superusuário, RLS seria ignorada e os
// casos abaixo passariam mesmo com um bug real de isolamento. Por
// isso o valor é forçado aqui, independente do que estiver no
// ambiente do shell que invocou o test runner.
process.env.DATABASE_URL =
  "postgresql://plantoes_app:plantoes_app_dev_local@localhost:5432/plantoes_medicos?schema=public";

describe("TenantContextService (integração — isolamento multi-tenant + RLS)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantContext: TenantContextService;

  let orgA: { id: string };
  let orgB: { id: string };
  let adminUser: { id: string };
  let shiftAId: string;
  let shiftBId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = moduleRef.get(PrismaService);
    tenantContext = moduleRef.get(TenantContextService);

    orgA = await prisma.organization.create({
      data: { name: `Hospital A ${randomUUID()}`, timezone: "America/Sao_Paulo" },
    });
    orgB = await prisma.organization.create({
      data: { name: `Hospital B ${randomUUID()}`, timezone: "America/Sao_Paulo" },
    });
    adminUser = await prisma.user.create({
      data: {
        oidcSubject: `tenant-test-admin-${randomUUID()}`,
        email: `tenant-test-admin-${randomUUID()}@example.com`,
        role: "HOSPITAL_ADMIN",
        organizationId: orgA.id,
      },
    });

    const shiftA = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.shift.create({
        data: {
          organizationId: orgA.id,
          specialty: "Cardiologia",
          valueCents: 50000,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
          status: "PUBLISHED",
          createdByUserId: adminUser.id,
        },
      }),
    );
    shiftAId = shiftA.id;

    const shiftB = await tenantContext.withTenantScope(orgB.id, (tx) =>
      tx.shift.create({
        data: {
          organizationId: orgB.id,
          specialty: "Pediatria",
          valueCents: 40000,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
          status: "PUBLISHED",
          createdByUserId: adminUser.id,
        },
      }),
    );
    shiftBId = shiftB.id;
  });

  afterAll(async () => {
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.shift.deleteMany({ where: { id: shiftAId } }));
    await tenantContext.withTenantScope(orgB.id, (tx) => tx.shift.deleteMany({ where: { id: shiftBId } }));
    await prisma.user.delete({ where: { id: adminUser.id } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await app.close();
  });

  it("requireHospitalOrganizationId falha fechado para usuário sem hospital associado", () => {
    const doctor: AuthenticatedUser = {
      id: "doctor-1",
      email: "doctor@example.com",
      role: "DOCTOR",
      organizationId: null,
    };
    expect(() => tenantContext.requireHospitalOrganizationId(doctor)).toThrow();
  });

  it("requireHospitalOrganizationId retorna o organizationId da sessão (nunca de input do cliente)", () => {
    const admin: AuthenticatedUser = {
      id: adminUser.id,
      email: "admin@example.com",
      role: "HOSPITAL_ADMIN",
      organizationId: orgA.id,
    };
    expect(tenantContext.requireHospitalOrganizationId(admin)).toBe(orgA.id);
  });

  it("withTenantScope falha fechado quando organizationId está vazio", async () => {
    await expect(tenantContext.withTenantScope("", async (tx) => tx.shift.findMany())).rejects.toThrow();
  });

  it("withTenantScope(org-a) só enxerga plantões do hospital A — RLS e middleware concordam", async () => {
    const shifts = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.shift.findMany({ where: { id: { in: [shiftAId, shiftBId] } } }),
    );
    expect(shifts.map((s) => s.id)).toEqual([shiftAId]);
  });

  it("withTenantScope(org-b) só enxerga plantões do hospital B", async () => {
    const shifts = await tenantContext.withTenantScope(orgB.id, (tx) =>
      tx.shift.findMany({ where: { id: { in: [shiftAId, shiftBId] } } }),
    );
    expect(shifts.map((s) => s.id)).toEqual([shiftBId]);
  });

  it("mesmo se organizationId de outro tenant for passado nos dados, RLS rejeita a escrita cross-tenant", async () => {
    await expect(
      tenantContext.withTenantScope(orgA.id, (tx) =>
        tx.shift.create({
          data: {
            organizationId: orgB.id, // valor "malicioso": não confere com o tenant escopado
            specialty: "Ortopedia",
            valueCents: 30000,
            startsAt: new Date(),
            endsAt: new Date(),
            status: "PUBLISHED",
            createdByUserId: adminUser.id,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
