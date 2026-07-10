import { beforeAll, afterAll, describe, expect, it } from "vitest";
import cookieParser from "cookie-parser";
import { Controller, Get, Module, Param, Post, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { UserRole } from "@prisma/client";
import { AppModule } from "../../src/app.module";
import { PrismaModule } from "../../src/prisma/prisma.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { OrganizationsModule } from "../../src/organizations/organizations.module";
import { TenantContextService } from "../../src/organizations/tenant-context";
import { SessionService, type SessionPayload } from "../../src/identity/session.service";
import { Roles } from "../../src/identity/decorators/roles.decorator";
import { CurrentUser } from "../../src/identity/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../../src/identity/guards/authentication.guard";

process.env.SESSION_SECRET ??= "test-only-session-secret-32-characters";
process.env.OIDC_ISSUER_URL = "";
process.env.COOKIE_SECURE ??= "true";
process.env.DATABASE_URL =
  "postgresql://plantoes_app:plantoes_app_dev_local@localhost:5432/plantoes_medicos?schema=public";

/**
 * Rotas fixture que representam operações hospitalares sensíveis
 * (ler e cancelar um plantão). Usadas apenas para exercitar, de
 * ponta a ponta, o caminho real que E-2+ vai seguir: RBAC ->
 * TenantContextService -> RLS. organizationId nunca é lido de
 * query/body — sempre de req.user, resolvido pela sessão.
 */
@Controller("test-security")
class TenantIsolationTestController {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly prisma: PrismaService,
  ) {}

  @Get("shifts/:id")
  @Roles(UserRole.DOCTOR, UserRole.HOSPITAL_ADMIN, UserRole.SUPERADMIN)
  async readShift(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const organizationId = this.tenantContext.requireHospitalOrganizationId(user);
    const shift = await this.tenantContext.withTenantScope(organizationId, (tx) =>
      tx.shift.findUnique({ where: { id } }),
    );
    return { shift };
  }

  @Post("shifts/:id/cancel")
  @Roles(UserRole.DOCTOR, UserRole.HOSPITAL_ADMIN, UserRole.SUPERADMIN)
  async cancelShift(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const organizationId = this.tenantContext.requireHospitalOrganizationId(user);
    const shift = await this.tenantContext.withTenantScope(organizationId, (tx) =>
      tx.shift.update({ where: { id }, data: { status: "CANCELLED" } }),
    );
    return { shift };
  }
}

@Module({
  imports: [PrismaModule, OrganizationsModule],
  controllers: [TenantIsolationTestController],
})
class TenantIsolationFixtureModule {}

describe("Isolamento cross-tenant (integração — leitura e escrita negadas para os 3 papéis)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;

  let orgA: { id: string };
  let orgB: { id: string };
  let shiftBId: string;

  const identities: Record<UserRole, { subject: string; email: string; organizationId: string | null }> = {
    DOCTOR: { subject: `doctor-${randomUUID()}`, email: `doctor-${randomUUID()}@example.com`, organizationId: null },
    HOSPITAL_ADMIN: {
      subject: `admin-a-${randomUUID()}`,
      email: `admin-a-${randomUUID()}@example.com`,
      organizationId: null, // preenchido em beforeAll com orgA.id
    },
    SUPERADMIN: { subject: `super-${randomUUID()}`, email: `super-${randomUUID()}@example.com`, organizationId: null },
  };

  function cookieFor(subject: string): string {
    const payload: SessionPayload = {
      subject,
      email: "irrelevant@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    let captured = "";
    const fakeRes = { cookie: (name: string, value: string) => (captured = `${name}=${value}`) } as unknown as Response;
    sessions.issue(fakeRes, payload);
    return captured;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, TenantIsolationFixtureModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    sessions = moduleRef.get(SessionService);
    tenantContext = moduleRef.get(TenantContextService);

    orgA = await prisma.organization.create({
      data: { name: `Hospital A ${randomUUID()}`, timezone: "America/Sao_Paulo" },
    });
    orgB = await prisma.organization.create({
      data: { name: `Hospital B ${randomUUID()}`, timezone: "America/Sao_Paulo" },
    });
    identities.HOSPITAL_ADMIN.organizationId = orgA.id;

    for (const [role, identity] of Object.entries(identities) as [UserRole, typeof identities.DOCTOR][]) {
      await prisma.user.create({
        data: {
          oidcSubject: identity.subject,
          email: identity.email,
          role,
          organizationId: identity.organizationId,
        },
      });
    }

    const adminUser = await prisma.user.findUniqueOrThrow({
      where: { oidcSubject: identities.HOSPITAL_ADMIN.subject },
    });

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
    await tenantContext.withTenantScope(orgB.id, (tx) => tx.shift.deleteMany({ where: { id: shiftBId } }));
    await prisma.user.deleteMany({
      where: { oidcSubject: { in: Object.values(identities).map((i) => i.subject) } },
    });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await app.close();
  });

  describe("Leitura cross-tenant é negada para os três papéis", () => {
    it("HOSPITAL_ADMIN de outro hospital (org-A) não consegue ler plantão de org-B", async () => {
      const res = await request(app.getHttpServer())
        .get(`/test-security/shifts/${shiftBId}`)
        .set("Cookie", cookieFor(identities.HOSPITAL_ADMIN.subject));
      // RLS filtra a linha: 200 com shift=null, nunca os dados de org-B.
      expect(res.status).toBe(200);
      expect(res.body.shift).toBeNull();
    });

    it("DOCTOR (sem hospital associado) é negado — sem fallback de tenant global", async () => {
      const res = await request(app.getHttpServer())
        .get(`/test-security/shifts/${shiftBId}`)
        .set("Cookie", cookieFor(identities.DOCTOR.subject));
      expect(res.status).toBe(403);
    });

    it("SUPERADMIN (sem hospital associado) é negado no caminho padrão de tenant — não há bypass implícito por papel", async () => {
      const res = await request(app.getHttpServer())
        .get(`/test-security/shifts/${shiftBId}`)
        .set("Cookie", cookieFor(identities.SUPERADMIN.subject));
      expect(res.status).toBe(403);
    });
  });

  describe("Escrita cross-tenant é negada para os três papéis", () => {
    it("HOSPITAL_ADMIN de org-A não consegue cancelar plantão de org-B", async () => {
      const res = await request(app.getHttpServer())
        .post(`/test-security/shifts/${shiftBId}/cancel`)
        .set("Cookie", cookieFor(identities.HOSPITAL_ADMIN.subject));
      expect(res.status).toBe(500); // Prisma "record not found" sob RLS: update não enxerga a linha
      const stillPublished = await tenantContext.withTenantScope(orgB.id, (tx) =>
        tx.shift.findUniqueOrThrow({ where: { id: shiftBId } }),
      );
      expect(stillPublished.status).toBe("PUBLISHED");
    });

    it("DOCTOR não consegue escrever em nenhum plantão hospitalar (sem tenant resolvido)", async () => {
      const res = await request(app.getHttpServer())
        .post(`/test-security/shifts/${shiftBId}/cancel`)
        .set("Cookie", cookieFor(identities.DOCTOR.subject));
      expect(res.status).toBe(403);
    });

    it("SUPERADMIN não consegue escrever via o caminho padrão de tenant (sem tenant resolvido)", async () => {
      const res = await request(app.getHttpServer())
        .post(`/test-security/shifts/${shiftBId}/cancel`)
        .set("Cookie", cookieFor(identities.SUPERADMIN.subject));
      expect(res.status).toBe(403);
    });
  });
});
