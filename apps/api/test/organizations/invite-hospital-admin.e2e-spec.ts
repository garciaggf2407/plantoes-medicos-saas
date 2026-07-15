import { beforeAll, afterAll, describe, expect, it } from "vitest";
import cookieParser from "cookie-parser";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
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

describe("POST /organizations/:id/admins (integração — convite de admin para hospital já existente)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;

  const superadmin = { subject: `super-${randomUUID()}`, email: `super-${randomUUID()}@example.com` };
  const doctor = { subject: `doctor-${randomUUID()}`, email: `doctor-${randomUUID()}@example.com` };

  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];
  let seededOrgId: string;

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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    sessions = moduleRef.get(SessionService);
    tenantContext = moduleRef.get(TenantContextService);

    const superadminUser = await prisma.user.create({
      data: { oidcSubject: superadmin.subject, email: superadmin.email, role: UserRole.SUPERADMIN },
    });
    const doctorUser = await prisma.user.create({
      data: { oidcSubject: doctor.subject, email: doctor.email, role: UserRole.DOCTOR },
    });
    createdUserIds.push(superadminUser.id, doctorUser.id);

    // Simula um hospital semeado (CNES) sem admin nenhum -- o cenário
    // real que motivou esta rota.
    const seededOrg = await prisma.organization.create({
      data: { name: `Hospital Seedado ${randomUUID()}`, timezone: "America/Sao_Paulo", city: "Bauru" },
    });
    seededOrgId = seededOrg.id;
    createdOrgIds.push(seededOrgId);
  });

  afterAll(async () => {
    const admin = createAdminPrismaForTestCleanup();
    await admin.auditLog.deleteMany({ where: { organizationId: { in: createdOrgIds } } });
    await admin.$disconnect();

    await prisma.user.deleteMany({ where: { organizationId: { in: createdOrgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    await app.close();
  });

  it("papel não autorizado (DOCTOR) recebe 403", async () => {
    const res = await request(app.getHttpServer())
      .post(`/organizations/${seededOrgId}/admins`)
      .set("Cookie", cookieFor(doctor.subject))
      .send({ email: `admin-${randomUUID()}@example.com` });
    expect(res.status).toBe(403);
  });

  it("sem sessão recebe 401", async () => {
    const res = await request(app.getHttpServer())
      .post(`/organizations/${seededOrgId}/admins`)
      .send({ email: `admin-${randomUUID()}@example.com` });
    expect(res.status).toBe(401);
  });

  it("hospital inexistente recebe 404", async () => {
    const res = await request(app.getHttpServer())
      .post(`/organizations/${randomUUID()}/admins`)
      .set("Cookie", cookieFor(superadmin.subject))
      .send({ email: `admin-${randomUUID()}@example.com` });
    expect(res.status).toBe(404);
  });

  it("SUPERADMIN convida admin pra hospital JÁ EXISTENTE com sucesso: convite pendente e auditoria", async () => {
    const adminEmail = `admin-${randomUUID()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(`/organizations/${seededOrgId}/admins`)
      .set("Cookie", cookieFor(superadmin.subject))
      .send({ email: adminEmail });

    expect(res.status).toBe(201);
    expect(res.body.invitedAdminUserId).toBeTruthy();

    const invitedAdmin = await prisma.user.findUnique({ where: { id: res.body.invitedAdminUserId } });
    expect(invitedAdmin?.role).toBe("HOSPITAL_ADMIN");
    expect(invitedAdmin?.organizationId).toBe(seededOrgId);
    expect(invitedAdmin?.email).toBe(adminEmail);
    expect(invitedAdmin?.oidcSubject.startsWith("pending:")).toBe(true);

    const superadminUser = await prisma.user.findUniqueOrThrow({ where: { oidcSubject: superadmin.subject } });
    const auditEntries = await tenantContext.withTenantScope(seededOrgId, (tx) =>
      tx.auditLog.findMany({ where: { organizationId: seededOrgId, action: "organization.admin_invited" } }),
    );
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]?.actorUserId).toBe(superadminUser.id);
    expect(auditEntries[0]?.justification).toContain(adminEmail);
  });

  it("rejeita email inválido com 400", async () => {
    const res = await request(app.getHttpServer())
      .post(`/organizations/${seededOrgId}/admins`)
      .set("Cookie", cookieFor(superadmin.subject))
      .send({ email: "nao-e-email" });
    expect(res.status).toBe(400);
  });

  it("rejeita email já usado por outro usuário com 400", async () => {
    const res = await request(app.getHttpServer())
      .post(`/organizations/${seededOrgId}/admins`)
      .set("Cookie", cookieFor(superadmin.subject))
      .send({ email: doctor.email });
    expect(res.status).toBe(400);
  });
});
