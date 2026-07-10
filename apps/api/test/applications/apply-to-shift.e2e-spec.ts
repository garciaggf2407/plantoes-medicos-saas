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

describe("POST /applications (integração — candidatura idempotente)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;

  const doctor = { subject: `doctor-${randomUUID()}`, email: `doctor-${randomUUID()}@example.com` };
  const adminA = { subject: `admin-a-${randomUUID()}`, email: `admin-a-${randomUUID()}@example.com` };
  let orgA: { id: string };
  const createdUserIds: string[] = [];
  let adminAUser: { id: string };
  let doctorUser: { id: string };

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

  async function createShift(overrides: Record<string, unknown> = {}): Promise<string> {
    const shift = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.shift.create({
        data: {
          organizationId: orgA.id,
          specialty: "Cardiologia",
          valueCents: 50000,
          startsAt: new Date("2026-09-01T08:00:00Z"),
          endsAt: new Date("2026-09-01T16:00:00Z"),
          status: "PUBLISHED",
          createdByUserId: adminAUser.id,
          ...overrides,
        },
      }),
    );
    return shift.id;
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

    const users = await Promise.all([
      prisma.user.create({ data: { oidcSubject: doctor.subject, email: doctor.email, role: UserRole.DOCTOR } }),
      prisma.user.create({ data: { oidcSubject: adminA.subject, email: adminA.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgA.id } }),
    ]);
    createdUserIds.push(...users.map((u) => u.id));
    doctorUser = users[0];
    adminAUser = users[1];

    await request(app.getHttpServer())
      .put("/doctors/me/profile")
      .set("Cookie", cookieFor(doctor.subject))
      .send({ crmNumber: "CRM-APPLY-1", specialties: ["Cardiologia"] });
  });

  afterAll(async () => {
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.application.deleteMany({ where: { organizationId: orgA.id } }));
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.credential.deleteMany({ where: { organizationId: orgA.id } }));
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.shift.deleteMany({ where: { organizationId: orgA.id } }));
    // audit_logs é imutável para a role de runtime (sem DELETE) — a
    // limpeza de teste (não o app) usa uma conexão privilegiada.
    const admin = createAdminPrismaForTestCleanup();
    await admin.auditLog.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
    await admin.$disconnect();

    await prisma.doctorProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id] } } });
    await app.close();
  });

  async function approveCredentialForDoctor(): Promise<void> {
    const submitRes = await request(app.getHttpServer())
      .post("/doctors/me/credentials")
      .set("Cookie", cookieFor(doctor.subject))
      .send({ organizationId: orgA.id, evidenceUrl: "https://files.example.com/crm.pdf" });

    await request(app.getHttpServer())
      .post(`/credentials/${submitRes.body.id}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "CRM conferido" });
  }

  it("rejeita candidatura sem credencial aprovada (erro específico)", async () => {
    const shiftId = await createShift({ specialty: "Ortopedia" });
    const res = await request(app.getHttpServer())
      .post("/applications")
      .set("Cookie", cookieFor(doctor.subject))
      .send({ shiftId, organizationId: orgA.id });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("credential_not_approved");
  });

  it("rejeita candidatura com especialidade incompatível", async () => {
    await approveCredentialForDoctor();
    const shiftId = await createShift({ specialty: "Neurologia" });
    const res = await request(app.getHttpServer())
      .post("/applications")
      .set("Cookie", cookieFor(doctor.subject))
      .send({ shiftId, organizationId: orgA.id });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("specialty_mismatch");
  });

  it("rejeita candidatura a plantão não publicado", async () => {
    const shiftId = await createShift({ status: "DRAFT" });
    const res = await request(app.getHttpServer())
      .post("/applications")
      .set("Cookie", cookieFor(doctor.subject))
      .send({ shiftId, organizationId: orgA.id });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("shift_not_published");
  });

  it("candidatura bem-sucedida fica PENDING", async () => {
    const shiftId = await createShift({ startsAt: new Date("2026-09-10T08:00:00Z"), endsAt: new Date("2026-09-10T16:00:00Z") });
    const res = await request(app.getHttpServer())
      .post("/applications")
      .set("Cookie", cookieFor(doctor.subject))
      .send({ shiftId, organizationId: orgA.id });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
  });

  it("repetição da mesma candidatura não cria duplicata (idempotente)", async () => {
    const shiftId = await createShift({ startsAt: new Date("2026-09-11T08:00:00Z"), endsAt: new Date("2026-09-11T16:00:00Z") });
    const first = await request(app.getHttpServer())
      .post("/applications")
      .set("Cookie", cookieFor(doctor.subject))
      .send({ shiftId, organizationId: orgA.id });
    const second = await request(app.getHttpServer())
      .post("/applications")
      .set("Cookie", cookieFor(doctor.subject))
      .send({ shiftId, organizationId: orgA.id });

    expect(first.body.id).toBe(second.body.id);

    const count = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.application.count({ where: { shiftId } }),
    );
    expect(count).toBe(1);
  });

  it("rejeita conflito de agenda com outra candidatura já APPROVED", async () => {
    const shiftId1 = await createShift({ startsAt: new Date("2026-09-15T08:00:00Z"), endsAt: new Date("2026-09-15T16:00:00Z") });
    const appRes = await request(app.getHttpServer())
      .post("/applications")
      .set("Cookie", cookieFor(doctor.subject))
      .send({ shiftId: shiftId1, organizationId: orgA.id });

    const profile = await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doctorUser.id } });
    await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.application.update({
        where: { id: appRes.body.id },
        data: { status: "APPROVED", decidedByUserId: adminAUser.id, decidedAt: new Date() },
      }),
    );
    void profile;

    const overlappingShiftId = await createShift({
      startsAt: new Date("2026-09-15T10:00:00Z"),
      endsAt: new Date("2026-09-15T18:00:00Z"),
    });
    const res = await request(app.getHttpServer())
      .post("/applications")
      .set("Cookie", cookieFor(doctor.subject))
      .send({ shiftId: overlappingShiftId, organizationId: orgA.id });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("schedule_conflict");
  });

  it("constraint de unicidade é do banco, não apenas do código (insert direto duplicado é rejeitado)", async () => {
    const shiftId = await createShift({ startsAt: new Date("2026-09-20T08:00:00Z"), endsAt: new Date("2026-09-20T16:00:00Z") });
    const profile = await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doctorUser.id } });

    await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.application.create({
        data: { shiftId, doctorProfileId: profile.id, organizationId: orgA.id, status: "PENDING" },
      }),
    );

    await expect(
      tenantContext.withTenantScope(orgA.id, (tx) =>
        tx.application.create({
          data: { shiftId, doctorProfileId: profile.id, organizationId: orgA.id, status: "PENDING" },
        }),
      ),
    ).rejects.toThrow();
  });
});
