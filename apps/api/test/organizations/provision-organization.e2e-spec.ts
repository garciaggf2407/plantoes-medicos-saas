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

process.env.SESSION_SECRET ??= "test-only-session-secret-32-characters";
process.env.OIDC_ISSUER_URL = "";
process.env.COOKIE_SECURE ??= "true";
process.env.DATABASE_URL =
  "postgresql://plantoes_app:plantoes_app_dev_local@localhost:5432/plantoes_medicos?schema=public";

describe("POST /organizations (integração — provisionamento restrito a superadmin)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;

  const superadmin = { subject: `super-${randomUUID()}`, email: `super-${randomUUID()}@example.com` };
  const doctor = { subject: `doctor-${randomUUID()}`, email: `doctor-${randomUUID()}@example.com` };

  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

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
  });

  afterAll(async () => {
    // audit_logs tem RLS: a limpeza precisa passar pelo mesmo escopo
    // de tenant usado para criar as linhas, senão o delete não
    // enxerga nada (RLS filtra, não lança erro) e o FK RESTRICT em
    // actor_user_id impede apagar os usuários de teste depois.
    for (const organizationId of createdOrgIds) {
      await tenantContext.withTenantScope(organizationId, (tx) =>
        tx.auditLog.deleteMany({ where: { organizationId } }),
      );
    }
    await prisma.user.deleteMany({ where: { organizationId: { in: createdOrgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    await app.close();
  });

  it("papel não autorizado (DOCTOR) recebe 403", async () => {
    const res = await request(app.getHttpServer())
      .post("/organizations")
      .set("Cookie", cookieFor(doctor.subject))
      .send({ name: "Hospital X", timezone: "America/Sao_Paulo", firstAdminEmail: `admin-${randomUUID()}@example.com` });
    expect(res.status).toBe(403);
  });

  it("sem sessão recebe 401", async () => {
    const res = await request(app.getHttpServer())
      .post("/organizations")
      .send({ name: "Hospital X", timezone: "America/Sao_Paulo", firstAdminEmail: `admin-${randomUUID()}@example.com` });
    expect(res.status).toBe(401);
  });

  it("SUPERADMIN provisiona hospital com sucesso: organização, admin convidado e auditoria", async () => {
    const firstAdminEmail = `admin-${randomUUID()}@example.com`;
    const res = await request(app.getHttpServer())
      .post("/organizations")
      .set("Cookie", cookieFor(superadmin.subject))
      .send({ name: "Hospital Central", timezone: "America/Sao_Paulo", firstAdminEmail });

    expect(res.status).toBe(201);
    expect(res.body.organizationId).toBeTruthy();
    createdOrgIds.push(res.body.organizationId);

    const invitedAdmin = await prisma.user.findUnique({ where: { id: res.body.invitedAdminUserId } });
    expect(invitedAdmin?.role).toBe("HOSPITAL_ADMIN");
    expect(invitedAdmin?.organizationId).toBe(res.body.organizationId);
    expect(invitedAdmin?.email).toBe(firstAdminEmail);
    expect(invitedAdmin?.oidcSubject.startsWith("pending:")).toBe(true);

    const superadminUser = await prisma.user.findUniqueOrThrow({ where: { oidcSubject: superadmin.subject } });
    const auditEntries = await tenantContext.withTenantScope(res.body.organizationId, (tx) =>
      tx.auditLog.findMany({
        where: { organizationId: res.body.organizationId, action: "organization.provisioned" },
      }),
    );
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]?.actorUserId).toBe(superadminUser.id);
    expect(auditEntries[0]?.createdAt).toBeInstanceOf(Date);
    expect(auditEntries[0]?.justification).toContain(firstAdminEmail);
  });

  it("organização criada já nasce isolada — nenhum plantão de outro hospital é visível nela", async () => {
    const firstAdminEmail = `admin-${randomUUID()}@example.com`;
    const res = await request(app.getHttpServer())
      .post("/organizations")
      .set("Cookie", cookieFor(superadmin.subject))
      .send({ name: "Hospital Isolado", timezone: "America/Sao_Paulo", firstAdminEmail });
    expect(res.status).toBe(201);
    createdOrgIds.push(res.body.organizationId);

    const shifts = await tenantContext.withTenantScope(res.body.organizationId, (tx) => tx.shift.findMany());
    expect(shifts).toHaveLength(0);
  });

  it("rejeita timezone IANA inválida com 400", async () => {
    const res = await request(app.getHttpServer())
      .post("/organizations")
      .set("Cookie", cookieFor(superadmin.subject))
      .send({ name: "Hospital Y", timezone: "Nao/Existe", firstAdminEmail: `admin-${randomUUID()}@example.com` });
    expect(res.status).toBe(400);
  });

  it("rejeita email inválido com 400", async () => {
    const res = await request(app.getHttpServer())
      .post("/organizations")
      .set("Cookie", cookieFor(superadmin.subject))
      .send({ name: "Hospital Z", timezone: "America/Sao_Paulo", firstAdminEmail: "nao-e-email" });
    expect(res.status).toBe(400);
  });
});
