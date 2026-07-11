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

  async function makeDoctorWithApprovedCredential(specialty: string): Promise<{ subject: string; profileId: string }> {
    const subject = `doctor-cmd-${randomUUID()}`;
    const user = await prisma.user.create({
      data: { oidcSubject: subject, email: `doctor-cmd-${randomUUID()}@example.com`, role: UserRole.DOCTOR },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.doctorProfile.create({
      data: { userId: user.id, crmNumber: `CRM-${randomUUID()}`, specialties: [specialty] },
    });
    const adminAUser = await prisma.user.findFirstOrThrow({ where: { oidcSubject: adminA.subject } });
    await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.credential.create({
        data: {
          doctorProfileId: profile.id,
          organizationId: orgA.id,
          evidenceUrl: "https://files.example.com/x.pdf",
          status: "APPROVED",
          reviewedByUserId: adminAUser.id,
          reviewedAt: new Date(),
        },
      }),
    );
    return { subject, profileId: profile.id };
  }

  async function applyAsDoctor(subject: string, shiftId: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/applications")
      .set("Cookie", cookieFor(subject))
      .send({ shiftId, organizationId: orgA.id });
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
    const admin = createAdminPrismaForTestCleanup();
    await admin.notification.deleteMany({ where: { organizationId: { in: [orgA.id, orgB.id] } } });
    await admin.emailDelivery.deleteMany({ where: { organizationId: { in: [orgA.id, orgB.id] } } });
    await admin.outboxEvent.deleteMany({ where: { organizationId: { in: [orgA.id, orgB.id] } } });
    await admin.$disconnect();
    for (const orgId of [orgA.id, orgB.id]) {
      await tenantContext.withTenantScope(orgId, (tx) => tx.application.deleteMany({ where: { organizationId: orgId } }));
      await tenantContext.withTenantScope(orgId, (tx) => tx.credential.deleteMany({ where: { organizationId: orgId } }));
      await tenantContext.withTenantScope(orgId, (tx) => tx.shift.deleteMany({ where: { organizationId: orgId } }));
    }
    await prisma.doctorProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
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

    it("bug real corrigido (auditoria): duas publicações concorrentes da mesma DRAFT nunca geram dois eventos shift.published", async () => {
      const id = await draftAsAdminA();

      const [res1, res2] = await Promise.all([
        request(app.getHttpServer()).post(`/shifts/${id}/publish`).set("Cookie", cookieFor(adminA.subject)),
        request(app.getHttpServer()).post(`/shifts/${id}/publish`).set("Cookie", cookieFor(adminA.subject)),
      ]);

      // Exatamente uma publicação vence (201); a outra perde a corrida
      // e vê PUBLISHED já como status de origem, então sua própria
      // checagem de VALID_TRANSITIONS rejeita com 400 -- nunca as duas
      // conseguem publicar (o que geraria dois eventos shift.published
      // distintos e duplicaria notificação/email para cada médico
      // compatível). Antes do FOR UPDATE em transition(), esta corrida
      // fazia as duas lerem DRAFT e as duas passarem.
      const successCount = [res1, res2].filter((r) => r.status === 201).length;
      expect(successCount).toBe(1);

      const events = await tenantContext.withTenantScope(orgA.id, (tx) =>
        tx.outboxEvent.findMany({ where: { organizationId: orgA.id, eventType: "shift.published" } }),
      );
      const eventsForThisShift = events.filter((e) => (e.payload as { shiftId?: string }).shiftId === id);
      expect(eventsForThisShift).toHaveLength(1);
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

    it("edita plantão PUBLISHED sem nenhuma candidatura", async () => {
      const id = await draftAsAdminA();
      await request(app.getHttpServer()).post(`/shifts/${id}/publish`).set("Cookie", cookieFor(adminA.subject));
      const res = await request(app.getHttpServer())
        .patch(`/shifts/${id}`)
        .set("Cookie", cookieFor(adminA.subject))
        .send({ valueCents: 70000 });
      expect(res.status).toBe(200);
      expect(res.body.valueCents).toBe(70000);
    });

    it("bug real corrigido (auditoria): plantão PUBLISHED com candidatura ativa não pode ter valor/horário editado por baixo do médico", async () => {
      const id = await draftAsAdminA();
      await request(app.getHttpServer()).post(`/shifts/${id}/publish`).set("Cookie", cookieFor(adminA.subject));
      const doctor = await makeDoctorWithApprovedCredential("Cardiologia");
      await applyAsDoctor(doctor.subject, id);

      const res = await request(app.getHttpServer())
        .patch(`/shifts/${id}`)
        .set("Cookie", cookieFor(adminA.subject))
        .send({ valueCents: 1 });
      expect(res.status).toBe(400);

      const shift = await tenantContext.withTenantScope(orgA.id, (tx) => tx.shift.findUniqueOrThrow({ where: { id } }));
      expect(shift.valueCents).toBe(50000);
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

    it("bug real corrigido (auditoria): cancelar plantão PUBLISHED rejeita candidaturas PENDING órfãs e notifica os candidatos", async () => {
      const id = await draftAsAdminA();
      await request(app.getHttpServer()).post(`/shifts/${id}/publish`).set("Cookie", cookieFor(adminA.subject));
      const doctor = await makeDoctorWithApprovedCredential("Cardiologia");
      const applicationId = await applyAsDoctor(doctor.subject, id);

      const res = await request(app.getHttpServer())
        .post(`/shifts/${id}/cancel`)
        .set("Cookie", cookieFor(adminA.subject));
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("CANCELLED");

      const application = await tenantContext.withTenantScope(orgA.id, (tx) =>
        tx.application.findUniqueOrThrow({ where: { id: applicationId } }),
      );
      expect(application.status).toBe("REJECTED");

      const events = await tenantContext.withTenantScope(orgA.id, (tx) =>
        tx.outboxEvent.findMany({ where: { organizationId: orgA.id, eventType: "application.decided" } }),
      );
      const eventForThisApplication = events.find(
        (e) => (e.payload as { applicationId?: string }).applicationId === applicationId,
      );
      expect(eventForThisApplication).toBeDefined();
      expect((eventForThisApplication?.payload as { decision?: string }).decision).toBe("REJECTED");
    });

    it("bug real corrigido (auditoria): aprovar uma candidatura PENDING de um plantão já CANCELLED é bloqueado (não ressuscita o plantão)", async () => {
      // Simula uma candidatura PENDING "órfã" sobrevivendo ao
      // cancelamento (o cenário que existia ANTES desta correção,
      // reproduzido aqui via manipulação direta do banco para provar
      // a defesa em profundidade da checagem em
      // ReviewApplicationUseCase, independente do auto-reject em
      // cancelShift já testado acima).
      const id = await draftAsAdminA();
      await request(app.getHttpServer()).post(`/shifts/${id}/publish`).set("Cookie", cookieFor(adminA.subject));
      const doctor = await makeDoctorWithApprovedCredential("Cardiologia");
      const applicationId = await applyAsDoctor(doctor.subject, id);

      await tenantContext.withTenantScope(orgA.id, (tx) =>
        tx.shift.update({ where: { id }, data: { status: "CANCELLED" } }),
      );

      const res = await request(app.getHttpServer())
        .post(`/applications/${applicationId}/review`)
        .set("Cookie", cookieFor(adminA.subject))
        .send({ organizationId: orgA.id, decision: "APPROVED", justification: "Aprovando candidatura órfã" });
      expect([400, 409]).toContain(res.status);

      const shift = await tenantContext.withTenantScope(orgA.id, (tx) => tx.shift.findUniqueOrThrow({ where: { id } }));
      expect(shift.status).toBe("CANCELLED");
    });
  });
});
