import { beforeAll, afterAll, describe, expect, it } from "vitest";
import cookieParser from "cookie-parser";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { UserRole } from "@prisma/client";
import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { TenantContextService } from "../../src/organizations/tenant-context";
import { SessionService, type SessionPayload } from "../../src/identity/session.service";
import { createAdminPrismaForTestCleanup } from "../support/admin-prisma";

process.env.SESSION_SECRET ??= "test-only-session-secret-32-characters";
process.env.OIDC_ISSUER_URL = "";
process.env.COOKIE_SECURE ??= "true";
process.env.DATABASE_URL =
  "postgresql://plantoes_app:plantoes_app_dev_local@localhost:5432/plantoes_medicos?schema=public";

/**
 * Leitura cross-tenant do SUPERADMIN (E-2, T-2.1.3): GET /organizations
 * e GET /organizations/:id/detail. Fixtures próprias (prefixo
 * "superadmin-e2e-", cleanup em afterAll) -- não depende dos hospitais
 * piloto (Campinas/Bauru) já existentes no banco de dev, para o teste
 * rodar isolado em qualquer ambiente.
 */
describe("Leitura cross-tenant do SUPERADMIN (integração — GET /organizations, GET /organizations/:id/detail)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;

  let orgA: { id: string; name: string };
  let orgB: { id: string; name: string };
  let shiftAId: string;
  let shiftBId: string;
  let applicationAId: string;
  let credentialAId: string;
  const createdUserIds: string[] = [];

  const superadmin = { subject: `superadmin-e2e-${randomUUID()}`, email: `superadmin-e2e-${randomUUID()}@example.com` };
  const doctor = { subject: `doctor-e2e-${randomUUID()}`, email: `doctor-e2e-${randomUUID()}@example.com` };
  const adminA = { subject: `admin-a-e2e-${randomUUID()}`, email: `admin-a-e2e-${randomUUID()}@example.com` };
  const adminB = { subject: `admin-b-e2e-${randomUUID()}`, email: `admin-b-e2e-${randomUUID()}@example.com` };

  function cookieFor(subject: string): string {
    const payload: SessionPayload = { subject, email: "irrelevant@example.com", exp: Math.floor(Date.now() / 1000) + 3600 };
    let captured = "";
    const fakeRes = { cookie: (name: string, value: string) => (captured = `${name}=${value}`) } as unknown as Response;
    sessions.issue(fakeRes, payload);
    return captured;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    sessions = moduleRef.get(SessionService);
    tenantContext = moduleRef.get(TenantContextService);

    orgA = await prisma.organization.create({
      data: { name: `Superadmin E2E Hospital A ${randomUUID()}`, timezone: "America/Sao_Paulo", city: "Cidade A" },
    });
    orgB = await prisma.organization.create({
      data: { name: `Superadmin E2E Hospital B ${randomUUID()}`, timezone: "America/Sao_Paulo", city: "Cidade B" },
    });

    const [superadminUser, doctorUser, adminAUser, adminBUser] = await Promise.all([
      prisma.user.create({ data: { oidcSubject: superadmin.subject, email: superadmin.email, role: UserRole.SUPERADMIN } }),
      prisma.user.create({ data: { oidcSubject: doctor.subject, email: doctor.email, role: UserRole.DOCTOR } }),
      prisma.user.create({
        data: { oidcSubject: adminA.subject, email: adminA.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgA.id },
      }),
      prisma.user.create({
        data: { oidcSubject: adminB.subject, email: adminB.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgB.id },
      }),
    ]);
    createdUserIds.push(superadminUser.id, doctorUser.id, adminAUser.id, adminBUser.id);

    const doctorProfile = await prisma.doctorProfile.create({
      data: { userId: doctorUser.id, crmNumber: "CRM-SUPERADMIN-E2E-1", specialties: ["Cardiologia"] },
    });

    const shiftA = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.shift.create({
        data: {
          organizationId: orgA.id,
          specialty: "Cardiologia",
          valueCents: 50000,
          startsAt: new Date("2026-09-01T08:00:00Z"),
          endsAt: new Date("2026-09-01T16:00:00Z"),
          status: "PUBLISHED",
          createdByUserId: adminAUser.id,
        },
      }),
    );
    shiftAId = shiftA.id;

    const applicationA = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.application.create({
        data: { shiftId: shiftA.id, doctorProfileId: doctorProfile.id, organizationId: orgA.id, status: "PENDING" },
      }),
    );
    applicationAId = applicationA.id;

    const credentialA = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.credential.create({
        data: { doctorProfileId: doctorProfile.id, organizationId: orgA.id, evidenceUrl: "https://files.example.com/crm-a.pdf" },
      }),
    );
    credentialAId = credentialA.id;

    // Dados de org-B existem só para provar isolamento -- nunca devem
    // aparecer no detalhe de org-A.
    const shiftB = await tenantContext.withTenantScope(orgB.id, (tx) =>
      tx.shift.create({
        data: {
          organizationId: orgB.id,
          specialty: "Pediatria",
          valueCents: 40000,
          startsAt: new Date("2026-09-02T08:00:00Z"),
          endsAt: new Date("2026-09-02T16:00:00Z"),
          status: "DRAFT",
          createdByUserId: adminBUser.id,
        },
      }),
    );
    shiftBId = shiftB.id;

    await tenantContext.withTenantScope(orgB.id, (tx) =>
      tx.application.create({
        data: { shiftId: shiftB.id, doctorProfileId: doctorProfile.id, organizationId: orgB.id, status: "PENDING" },
      }),
    );
    await tenantContext.withTenantScope(orgB.id, (tx) =>
      tx.credential.create({
        data: { doctorProfileId: doctorProfile.id, organizationId: orgB.id, evidenceUrl: "https://files.example.com/crm-b.pdf" },
      }),
    );
  });

  afterAll(async () => {
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.application.deleteMany({ where: { organizationId: orgA.id } }));
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.credential.deleteMany({ where: { organizationId: orgA.id } }));
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.shift.deleteMany({ where: { organizationId: orgA.id } }));
    await tenantContext.withTenantScope(orgB.id, (tx) => tx.application.deleteMany({ where: { organizationId: orgB.id } }));
    await tenantContext.withTenantScope(orgB.id, (tx) => tx.credential.deleteMany({ where: { organizationId: orgB.id } }));
    await tenantContext.withTenantScope(orgB.id, (tx) => tx.shift.deleteMany({ where: { organizationId: orgB.id } }));

    // audit_logs é imutável para a role de runtime (sem DELETE/UPDATE
    // -- ver migration audit_log_immutable) -- limpeza de teste usa
    // conexão privilegiada, nunca o app.
    const admin = createAdminPrismaForTestCleanup();
    await admin.auditLog.deleteMany({ where: { organizationId: { in: [orgA.id, orgB.id] } } });
    await admin.$disconnect();

    await prisma.doctorProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await app.close();
  });

  it("(1) SUPERADMIN em GET /organizations vê os hospitais criados pelo teste", async () => {
    const res = await request(app.getHttpServer()).get("/organizations").set("Cookie", cookieFor(superadmin.subject));
    expect(res.status).toBe(200);

    const ids = (res.body as Array<{ id: string }>).map((o) => o.id);
    expect(ids).toContain(orgA.id);
    expect(ids).toContain(orgB.id);

    const foundA = (res.body as Array<{ id: string; name: string; city: string | null }>).find((o) => o.id === orgA.id);
    expect(foundA).toMatchObject({ name: orgA.name, city: "Cidade A" });
  });

  it("(2) GET /organizations/:id/detail retorna plantões+candidaturas+credenciais SÓ do hospital pedido, nunca de outro", async () => {
    const res = await request(app.getHttpServer())
      .get(`/organizations/${orgA.id}/detail`)
      .set("Cookie", cookieFor(superadmin.subject));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(orgA.id);
    expect(res.body.name).toBe(orgA.name);

    const shiftIds = (res.body.shifts as Array<{ id: string }>).map((s) => s.id);
    expect(shiftIds).toContain(shiftAId);
    expect(shiftIds).not.toContain(shiftBId);

    const applicationIds = (res.body.applications as Array<{ id: string }>).map((a) => a.id);
    expect(applicationIds).toContain(applicationAId);

    const credentialIds = (res.body.credentials as Array<{ id: string }>).map((c) => c.id);
    expect(credentialIds).toContain(credentialAId);
  });

  it("(3) cada chamada a /detail grava exatamente 1 AuditLog novo com action organization.viewed_by_superadmin", async () => {
    const admin = createAdminPrismaForTestCleanup();
    try {
      const before = await admin.auditLog.count({
        where: { organizationId: orgA.id, action: "organization.viewed_by_superadmin" },
      });

      const res = await request(app.getHttpServer())
        .get(`/organizations/${orgA.id}/detail`)
        .set("Cookie", cookieFor(superadmin.subject));
      expect(res.status).toBe(200);

      const after = await admin.auditLog.count({
        where: { organizationId: orgA.id, action: "organization.viewed_by_superadmin" },
      });
      expect(after - before).toBe(1);

      const latest = await admin.auditLog.findFirst({
        where: { organizationId: orgA.id, action: "organization.viewed_by_superadmin" },
        orderBy: { createdAt: "desc" },
      });
      expect(latest?.targetType).toBe("Organization");
      expect(latest?.targetId).toBe(orgA.id);
    } finally {
      await admin.$disconnect();
    }
  });

  it("(4) DOCTOR autenticado recebe 403 em GET /organizations e GET /organizations/:id/detail", async () => {
    const listRes = await request(app.getHttpServer()).get("/organizations").set("Cookie", cookieFor(doctor.subject));
    expect(listRes.status).toBe(403);

    const detailRes = await request(app.getHttpServer())
      .get(`/organizations/${orgA.id}/detail`)
      .set("Cookie", cookieFor(doctor.subject));
    expect(detailRes.status).toBe(403);
  });

  it("(5) HOSPITAL_ADMIN autenticado recebe 403 em ambas as rotas, mesmo tentando ver o PRÓPRIO hospital", async () => {
    const listRes = await request(app.getHttpServer()).get("/organizations").set("Cookie", cookieFor(adminA.subject));
    expect(listRes.status).toBe(403);

    const detailOwnRes = await request(app.getHttpServer())
      .get(`/organizations/${orgA.id}/detail`)
      .set("Cookie", cookieFor(adminA.subject));
    expect(detailOwnRes.status).toBe(403);

    const detailOtherRes = await request(app.getHttpServer())
      .get(`/organizations/${orgB.id}/detail`)
      .set("Cookie", cookieFor(adminA.subject));
    expect(detailOtherRes.status).toBe(403);
  });
});
