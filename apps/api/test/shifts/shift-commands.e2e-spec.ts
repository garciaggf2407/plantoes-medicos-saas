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

describe("Shift commands (integração — rascunhar, publicar, editar, cancelar)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;

  const adminA = { subject: `admin-a-${randomUUID()}`, email: `admin-a-${randomUUID()}@example.com` };
  const adminB = { subject: `admin-b-${randomUUID()}`, email: `admin-b-${randomUUID()}@example.com` };
  const doctor = { subject: `doctor-${randomUUID()}`, email: `doctor-${randomUUID()}@example.com` };

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

  function draftPayload(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      specialty: "Cardiologia",
      valueCents: 50000,
      startsAt: "2026-08-01T08:00:00Z",
      endsAt: "2026-08-01T16:00:00Z",
      ...overrides,
    };
  }

  async function draftAsAdminA(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/shifts")
      .set("Cookie", cookieFor(adminA.subject))
      .send(draftPayload());
    return res.body.id as string;
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

    const users = await Promise.all([
      prisma.user.create({ data: { oidcSubject: adminA.subject, email: adminA.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgA.id } }),
      prisma.user.create({ data: { oidcSubject: adminB.subject, email: adminB.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgB.id } }),
      prisma.user.create({ data: { oidcSubject: doctor.subject, email: doctor.email, role: UserRole.DOCTOR } }),
    ]);
    createdUserIds.push(...users.map((u) => u.id));
  });

  afterAll(async () => {
    for (const orgId of [orgA.id, orgB.id]) {
      await tenantContext.withTenantScope(orgId, (tx) => tx.shift.deleteMany({ where: { organizationId: orgId } }));
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await app.close();
  });

  describe("draftShift (POST /shifts)", () => {
    it("hospital_admin rascunha um plantão em DRAFT", async () => {
      const res = await request(app.getHttpServer())
        .post("/shifts")
        .set("Cookie", cookieFor(adminA.subject))
        .send(draftPayload());
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("DRAFT");
      expect(res.body.valueCents).toBe(50000);
    });

    it("DOCTOR não consegue rascunhar plantão (403)", async () => {
      const res = await request(app.getHttpServer())
        .post("/shifts")
        .set("Cookie", cookieFor(doctor.subject))
        .send(draftPayload());
      expect(res.status).toBe(403);
    });

    it("rejeita valueCents não-inteiro (dinheiro sempre em centavos)", async () => {
      const res = await request(app.getHttpServer())
        .post("/shifts")
        .set("Cookie", cookieFor(adminA.subject))
        .send(draftPayload({ valueCents: 500.5 }));
      expect(res.status).toBe(400);
    });

    it("rejeita valueCents negativo ou zero", async () => {
      const res = await request(app.getHttpServer())
        .post("/shifts")
        .set("Cookie", cookieFor(adminA.subject))
        .send(draftPayload({ valueCents: 0 }));
      expect(res.status).toBe(400);
    });

    it("rejeita data sem timezone explícito (UTC/IANA obrigatório)", async () => {
      const res = await request(app.getHttpServer())
        .post("/shifts")
        .set("Cookie", cookieFor(adminA.subject))
        .send(draftPayload({ startsAt: "2026-08-01T08:00:00" }));
      expect(res.status).toBe(400);
    });

    it("rejeita endsAt <= startsAt", async () => {
      const res = await request(app.getHttpServer())
        .post("/shifts")
        .set("Cookie", cookieFor(adminA.subject))
        .send(draftPayload({ endsAt: "2026-08-01T08:00:00Z" }));
      expect(res.status).toBe(400);
    });
  });

  describe("publishShift (POST /shifts/:id/publish)", () => {
    it("publica um plantão em DRAFT", async () => {
      const id = await draftAsAdminA();
      const res = await request(app.getHttpServer())
        .post(`/shifts/${id}/publish`)
        .set("Cookie", cookieFor(adminA.subject));
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("PUBLISHED");
    });

    it("admin de outro hospital não consegue publicar plantão de org-A (404 sob RLS)", async () => {
      const id = await draftAsAdminA();
      const res = await request(app.getHttpServer())
        .post(`/shifts/${id}/publish`)
        .set("Cookie", cookieFor(adminB.subject));
      expect([403, 404]).toContain(res.status);
    });

    it("transição inválida é rejeitada: PUBLISHED -> PUBLISHED de novo", async () => {
      const id = await draftAsAdminA();
      await request(app.getHttpServer()).post(`/shifts/${id}/publish`).set("Cookie", cookieFor(adminA.subject));
      const res = await request(app.getHttpServer())
        .post(`/shifts/${id}/publish`)
        .set("Cookie", cookieFor(adminA.subject));
      expect(res.status).toBe(400);
    });
  });

  describe("editShift (PATCH /shifts/:id)", () => {
    it("edita specialty e valueCents de um plantão em DRAFT", async () => {
      const id = await draftAsAdminA();
      const res = await request(app.getHttpServer())
        .patch(`/shifts/${id}`)
        .set("Cookie", cookieFor(adminA.subject))
        .send({ specialty: "Pediatria", valueCents: 60000 });
      expect(res.status).toBe(200);
      expect(res.body.specialty).toBe("Pediatria");
      expect(res.body.valueCents).toBe(60000);
    });

    it("rejeita edição de plantão CANCELLED", async () => {
      const id = await draftAsAdminA();
      await request(app.getHttpServer()).post(`/shifts/${id}/cancel`).set("Cookie", cookieFor(adminA.subject));
      const res = await request(app.getHttpServer())
        .patch(`/shifts/${id}`)
        .set("Cookie", cookieFor(adminA.subject))
        .send({ specialty: "Pediatria" });
      expect(res.status).toBe(400);
    });
  });

  describe("cancelShift (POST /shifts/:id/cancel)", () => {
    it("cancela um plantão em DRAFT", async () => {
      const id = await draftAsAdminA();
      const res = await request(app.getHttpServer())
        .post(`/shifts/${id}/cancel`)
        .set("Cookie", cookieFor(adminA.subject));
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("CANCELLED");
    });

    it("cancela um plantão PUBLISHED", async () => {
      const id = await draftAsAdminA();
      await request(app.getHttpServer()).post(`/shifts/${id}/publish`).set("Cookie", cookieFor(adminA.subject));
      const res = await request(app.getHttpServer())
        .post(`/shifts/${id}/cancel`)
        .set("Cookie", cookieFor(adminA.subject));
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("CANCELLED");
    });

    it("transição inválida é rejeitada: CANCELLED -> CANCELLED de novo", async () => {
      const id = await draftAsAdminA();
      await request(app.getHttpServer()).post(`/shifts/${id}/cancel`).set("Cookie", cookieFor(adminA.subject));
      const res = await request(app.getHttpServer())
        .post(`/shifts/${id}/cancel`)
        .set("Cookie", cookieFor(adminA.subject));
      expect(res.status).toBe(400);
    });
  });
});
