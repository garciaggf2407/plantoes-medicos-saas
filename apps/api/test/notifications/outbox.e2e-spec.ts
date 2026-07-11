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
import { OutboxService } from "../../src/notifications/outbox.service";
import { SessionService, type SessionPayload } from "../../src/identity/session.service";
import { createAdminPrismaForTestCleanup } from "../support/admin-prisma";

process.env.SESSION_SECRET ??= "test-only-session-secret-32-characters";
process.env.OIDC_ISSUER_URL = "";
process.env.COOKIE_SECURE ??= "true";
process.env.DATABASE_URL =
  "postgresql://plantoes_app:plantoes_app_dev_local@localhost:5432/plantoes_medicos?schema=public";

describe("Outbox transacional (integração — T-5.1.1)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;
  let outbox: OutboxService;

  const adminA = { subject: `admin-a-${randomUUID()}`, email: `admin-a-${randomUUID()}@example.com` };
  let orgA: { id: string };
  let adminAUserId: string;
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

  async function makeDoctorWithApprovedCredential(specialty: string): Promise<{ subject: string; profileId: string }> {
    const subject = `doctor-${randomUUID()}`;
    const user = await prisma.user.create({
      data: { oidcSubject: subject, email: `doctor-${randomUUID()}@example.com`, role: UserRole.DOCTOR },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.doctorProfile.create({
      data: { userId: user.id, crmNumber: `CRM-${randomUUID()}`, specialties: [specialty] },
    });
    await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.credential.create({
        data: { doctorProfileId: profile.id, organizationId: orgA.id, evidenceUrl: "https://files.example.com/x.pdf", status: "APPROVED", reviewedByUserId: adminAUserId, reviewedAt: new Date() },
      }),
    );
    return { subject, profileId: profile.id };
  }

  async function draftShiftAsAdminA(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/shifts")
      .set("Cookie", cookieFor(adminA.subject))
      .send({ specialty: "Cardiologia", valueCents: 50000, startsAt: "2026-09-01T08:00:00Z", endsAt: "2026-09-01T16:00:00Z" });
    return res.body.id as string;
  }

  async function applyAsDoctor(subject: string, shiftId: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/applications")
      .set("Cookie", cookieFor(subject))
      .send({ shiftId, organizationId: orgA.id });
    return res.body.id as string;
  }

  async function outboxEventsFor(shiftId: string, eventType: string) {
    return tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.outboxEvent.findMany({ where: { organizationId: orgA.id, eventType } }).then((rows) =>
        rows.filter((row) => (row.payload as Record<string, unknown>).shiftId === shiftId),
      ),
    );
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    sessions = moduleRef.get(SessionService);
    tenantContext = moduleRef.get(TenantContextService);
    outbox = moduleRef.get(OutboxService);

    orgA = await prisma.organization.create({ data: { name: `Hospital A ${randomUUID()}`, timezone: "America/Sao_Paulo" } });
    const adminAUser = await prisma.user.create({
      data: { oidcSubject: adminA.subject, email: adminA.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgA.id },
    });
    createdUserIds.push(adminAUser.id);
    adminAUserId = adminAUser.id;
  });

  afterAll(async () => {
    const admin = createAdminPrismaForTestCleanup();
    await admin.outboxEvent.deleteMany({ where: { organizationId: orgA.id } });
    await admin.auditLog.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
    await admin.$disconnect();
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.application.deleteMany({ where: { organizationId: orgA.id } }));
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.credential.deleteMany({ where: { organizationId: orgA.id } }));
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.shift.deleteMany({ where: { organizationId: orgA.id } }));
    await prisma.doctorProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: orgA.id } });
    await app.close();
  });

  it("publicar um plantão grava um evento shift.published na mesma transação", async () => {
    const shiftId = await draftShiftAsAdminA();
    const res = await request(app.getHttpServer())
      .post(`/shifts/${shiftId}/publish`)
      .set("Cookie", cookieFor(adminA.subject));
    expect(res.status).toBe(201);

    const events = await outboxEventsFor(shiftId, "shift.published");
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("PENDING");
    expect(events[0]?.payload).toMatchObject({ version: 1, shiftId, specialty: "Cardiologia" });
  });

  it("aprovar uma candidatura grava um evento application.decided (APPROVED)", async () => {
    const shiftId = await draftShiftAsAdminA();
    await request(app.getHttpServer()).post(`/shifts/${shiftId}/publish`).set("Cookie", cookieFor(adminA.subject));
    const doctor = await makeDoctorWithApprovedCredential("Cardiologia");
    const applicationId = await applyAsDoctor(doctor.subject, shiftId);

    const res = await request(app.getHttpServer())
      .post(`/applications/${applicationId}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "CRM conferido" });
    expect(res.status).toBe(201);

    const events = await outboxEventsFor(shiftId, "application.decided");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      version: 1,
      applicationId,
      shiftId,
      doctorProfileId: doctor.profileId,
      decision: "APPROVED",
    });
  });

  it("rejeitar uma candidatura grava um evento application.decided (REJECTED)", async () => {
    const shiftId = await draftShiftAsAdminA();
    await request(app.getHttpServer()).post(`/shifts/${shiftId}/publish`).set("Cookie", cookieFor(adminA.subject));
    const doctor = await makeDoctorWithApprovedCredential("Cardiologia");
    const applicationId = await applyAsDoctor(doctor.subject, shiftId);

    const res = await request(app.getHttpServer())
      .post(`/applications/${applicationId}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "REJECTED", justification: "Documentação incompleta" });
    expect(res.status).toBe(201);

    const events = await outboxEventsFor(shiftId, "application.decided");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      version: 1,
      applicationId,
      shiftId,
      doctorProfileId: doctor.profileId,
      decision: "REJECTED",
    });
  });

  it("atomicidade real: se a transação falhar depois do enqueue, o evento NUNCA fica órfão (rollback conjunto)", async () => {
    const shiftId = await draftShiftAsAdminA();
    const marker = `atomic-rollback-${randomUUID()}`;

    await expect(
      tenantContext.withTenantScope(orgA.id, async (tx) => {
        await outbox.enqueue(tx, orgA.id, "shift.published", {
          version: 1,
          shiftId,
          specialty: marker,
        });
        // Falha deliberada depois do enqueue, ainda dentro da mesma
        // transação: prova que o evento não sobrevive sem a mudança
        // de negócio que o acompanha (nem vice-versa).
        throw new Error("forced-failure-after-enqueue");
      }),
    ).rejects.toThrow("forced-failure-after-enqueue");

    const orphanedEvents = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.outboxEvent.findMany({ where: { organizationId: orgA.id, eventType: "shift.published" } }).then((rows) =>
        rows.filter((row) => (row.payload as Record<string, unknown>).specialty === marker),
      ),
    );
    expect(orphanedEvents).toHaveLength(0);
  });

  it("atomicidade real: sucesso da transação persiste o evento junto com a mudança de negócio", async () => {
    const shiftId = await draftShiftAsAdminA();
    const marker = `atomic-commit-${randomUUID()}`;

    await tenantContext.withTenantScope(orgA.id, async (tx) => {
      await outbox.enqueue(tx, orgA.id, "shift.published", {
        version: 1,
        shiftId,
        specialty: marker,
      });
      await tx.shift.update({ where: { id: shiftId }, data: { status: "PUBLISHED" } });
    });

    const shift = await tenantContext.withTenantScope(orgA.id, (tx) => tx.shift.findUniqueOrThrow({ where: { id: shiftId } }));
    expect(shift.status).toBe("PUBLISHED");

    const events = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.outboxEvent.findMany({ where: { organizationId: orgA.id, eventType: "shift.published" } }).then((rows) =>
        rows.filter((row) => (row.payload as Record<string, unknown>).specialty === marker),
      ),
    );
    expect(events).toHaveLength(1);
  });
});
