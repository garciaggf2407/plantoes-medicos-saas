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

describe("Perfil médico e credenciais (integração)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;

  const doctorA = { subject: `doctor-a-${randomUUID()}`, email: `doctor-a-${randomUUID()}@example.com` };
  const doctorB = { subject: `doctor-b-${randomUUID()}`, email: `doctor-b-${randomUUID()}@example.com` };
  let adminSameOrg: { subject: string; email: string };
  let adminOtherOrg: { subject: string; email: string };

  let orgA: { id: string };
  let orgB: { id: string };
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

    orgA = await prisma.organization.create({ data: { name: `Hospital A ${randomUUID()}`, timezone: "America/Sao_Paulo" } });
    orgB = await prisma.organization.create({ data: { name: `Hospital B ${randomUUID()}`, timezone: "America/Sao_Paulo" } });

    adminSameOrg = { subject: `admin-a-${randomUUID()}`, email: `admin-a-${randomUUID()}@example.com` };
    adminOtherOrg = { subject: `admin-b-${randomUUID()}`, email: `admin-b-${randomUUID()}@example.com` };

    const users = await Promise.all([
      prisma.user.create({ data: { oidcSubject: doctorA.subject, email: doctorA.email, role: UserRole.DOCTOR } }),
      prisma.user.create({ data: { oidcSubject: doctorB.subject, email: doctorB.email, role: UserRole.DOCTOR } }),
      prisma.user.create({
        data: { oidcSubject: adminSameOrg.subject, email: adminSameOrg.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgA.id },
      }),
      prisma.user.create({
        data: { oidcSubject: adminOtherOrg.subject, email: adminOtherOrg.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgB.id },
      }),
    ]);
    createdUserIds.push(...users.map((u) => u.id));
  });

  afterAll(async () => {
    for (const orgId of [orgA.id, orgB.id]) {
      await tenantContext.withTenantScope(orgId, (tx) => tx.credential.deleteMany({ where: { organizationId: orgId } }));
    }
    // audit_logs é imutável para a role de runtime (sem DELETE) — a
    // limpeza de teste (não o app) usa uma conexão privilegiada.
    const admin = createAdminPrismaForTestCleanup();
    await admin.auditLog.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
    await admin.$disconnect();

    await prisma.doctorProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await app.close();
  });

  describe("PUT /doctors/me/profile", () => {
    it("médico cria o próprio perfil com sucesso", async () => {
      const res = await request(app.getHttpServer())
        .put("/doctors/me/profile")
        .set("Cookie", cookieFor(doctorA.subject))
        .send({ crmNumber: "CRM-12345", specialties: ["Cardiologia"], contactPhone: "+55 11 99999-0000" });
      expect(res.status).toBe(200);
      expect(res.body.crmNumber).toBe("CRM-12345");
    });

    it("HOSPITAL_ADMIN não consegue usar a rota de perfil de médico (403)", async () => {
      const res = await request(app.getHttpServer())
        .put("/doctors/me/profile")
        .set("Cookie", cookieFor(adminSameOrg.subject))
        .send({ crmNumber: "CRM-99999", specialties: ["Pediatria"] });
      expect(res.status).toBe(403);
    });

    it("rejeita specialties vazio com 400", async () => {
      const res = await request(app.getHttpServer())
        .put("/doctors/me/profile")
        .set("Cookie", cookieFor(doctorA.subject))
        .send({ crmNumber: "CRM-12345", specialties: [] });
      expect(res.status).toBe(400);
    });

    it("alteração de perfil gera registro de auditoria (organizationId nulo, ator correto)", async () => {
      await request(app.getHttpServer())
        .put("/doctors/me/profile")
        .set("Cookie", cookieFor(doctorA.subject))
        .send({ crmNumber: "CRM-12345", specialties: ["Cardiologia", "Clínica Geral"] });

      const doctorAUser = await prisma.user.findUniqueOrThrow({ where: { oidcSubject: doctorA.subject } });
      const profile = await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doctorAUser.id } });
      const entries = await tenantContext.withSelfAuthoredAudit(doctorAUser.id, (tx) =>
        tx.auditLog.findMany({ where: { targetType: "DoctorProfile", targetId: profile.id } }),
      );
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries.every((e) => e.organizationId === null)).toBe(true);
      expect(entries.every((e) => e.actorUserId === doctorAUser.id)).toBe(true);
    });

    it("médico só altera o próprio perfil (perfil de B não é afetado pela chamada de A)", async () => {
      await request(app.getHttpServer())
        .put("/doctors/me/profile")
        .set("Cookie", cookieFor(doctorB.subject))
        .send({ crmNumber: "CRM-B-0001", specialties: ["Ortopedia"] });

      const resA = await request(app.getHttpServer()).get("/doctors/me/profile").set("Cookie", cookieFor(doctorA.subject));
      const resB = await request(app.getHttpServer()).get("/doctors/me/profile").set("Cookie", cookieFor(doctorB.subject));

      expect(resA.body.crmNumber).not.toBe(resB.body.crmNumber);
      expect(resB.body.crmNumber).toBe("CRM-B-0001");
    });
  });

  describe("POST /doctors/me/credentials + GET /credentials/:id", () => {
    it("médico envia evidência de CRM para um hospital", async () => {
      const res = await request(app.getHttpServer())
        .post("/doctors/me/credentials")
        .set("Cookie", cookieFor(doctorA.subject))
        .send({ organizationId: orgA.id, evidenceUrl: "https://files.example.com/crm-doctor-a.pdf" });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("PENDING");
    });

    it("evidência de CRM é visível para o médico dono", async () => {
      const submit = await request(app.getHttpServer())
        .post("/doctors/me/credentials")
        .set("Cookie", cookieFor(doctorA.subject))
        .send({ organizationId: orgA.id, evidenceUrl: "https://files.example.com/crm-doctor-a.pdf" });

      const res = await request(app.getHttpServer())
        .get(`/credentials/${submit.body.id}`)
        .query({ organizationId: orgA.id })
        .set("Cookie", cookieFor(doctorA.subject));
      expect(res.status).toBe(200);
      expect(res.body.evidenceUrl).toBe("https://files.example.com/crm-doctor-a.pdf");
    });

    it("evidência de CRM é visível para o admin do hospital vinculado", async () => {
      const submit = await request(app.getHttpServer())
        .post("/doctors/me/credentials")
        .set("Cookie", cookieFor(doctorA.subject))
        .send({ organizationId: orgA.id, evidenceUrl: "https://files.example.com/crm-doctor-a.pdf" });

      const res = await request(app.getHttpServer())
        .get(`/credentials/${submit.body.id}`)
        .query({ organizationId: orgA.id })
        .set("Cookie", cookieFor(adminSameOrg.subject));
      expect(res.status).toBe(200);
    });

    it("evidência de CRM NÃO é visível para admin de outro hospital", async () => {
      const submit = await request(app.getHttpServer())
        .post("/doctors/me/credentials")
        .set("Cookie", cookieFor(doctorA.subject))
        .send({ organizationId: orgA.id, evidenceUrl: "https://files.example.com/crm-doctor-a.pdf" });

      const res = await request(app.getHttpServer())
        .get(`/credentials/${submit.body.id}`)
        .query({ organizationId: orgA.id })
        .set("Cookie", cookieFor(adminOtherOrg.subject));
      expect(res.status).toBe(403);
    });

    it("evidência de CRM NÃO é visível para outro médico", async () => {
      const submit = await request(app.getHttpServer())
        .post("/doctors/me/credentials")
        .set("Cookie", cookieFor(doctorA.subject))
        .send({ organizationId: orgA.id, evidenceUrl: "https://files.example.com/crm-doctor-a.pdf" });

      const res = await request(app.getHttpServer())
        .get(`/credentials/${submit.body.id}`)
        .query({ organizationId: orgA.id })
        .set("Cookie", cookieFor(doctorB.subject));
      expect(res.status).toBe(403);
    });

    it("rejeita organizationId inexistente com 400", async () => {
      const res = await request(app.getHttpServer())
        .post("/doctors/me/credentials")
        .set("Cookie", cookieFor(doctorA.subject))
        .send({ organizationId: randomUUID(), evidenceUrl: "https://files.example.com/x.pdf" });
      expect(res.status).toBe(400);
    });

    it("rejeita evidenceUrl inválida com 400", async () => {
      const res = await request(app.getHttpServer())
        .post("/doctors/me/credentials")
        .set("Cookie", cookieFor(doctorA.subject))
        .send({ organizationId: orgA.id, evidenceUrl: "not-a-url" });
      expect(res.status).toBe(400);
    });
  });
});
