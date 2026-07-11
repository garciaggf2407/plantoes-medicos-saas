import { beforeAll, afterAll, describe, expect, it } from "vitest";
import cookieParser from "cookie-parser";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { UserRole, type Prisma } from "@prisma/client";
import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { TenantContextService } from "../../src/organizations/tenant-context";
import { NotificationWorkerService } from "../../src/notifications/notification.worker";
import { InAppService } from "../../src/notifications/in-app.service";
import { SessionService, type SessionPayload } from "../../src/identity/session.service";
import { createAdminPrismaForTestCleanup } from "../support/admin-prisma";

process.env.SESSION_SECRET ??= "test-only-session-secret-32-characters";
process.env.OIDC_ISSUER_URL = "";
process.env.COOKIE_SECURE ??= "true";
process.env.DATABASE_URL =
  "postgresql://plantoes_app:plantoes_app_dev_local@localhost:5432/plantoes_medicos?schema=public";

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`waitFor: condição não satisfeita em ${timeoutMs}ms`);
}

describe("Notificações in-app (integração — T-5.1.3)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;
  let worker: NotificationWorkerService;

  const adminA = { subject: `admin-a-${randomUUID()}`, email: `admin-a-${randomUUID()}@example.com` };
  const doctorCardio = { subject: `doctor-cardio-${randomUUID()}`, email: `doctor-cardio-${randomUUID()}@example.com` };
  const doctorOrtho = { subject: `doctor-ortho-${randomUUID()}`, email: `doctor-ortho-${randomUUID()}@example.com` };
  let orgA: { id: string };
  let adminAUser: { id: string };
  const createdUserIds: string[] = [];

  function cookieFor(subject: string): string {
    const payload: SessionPayload = { subject, email: "irrelevant@example.com", exp: Math.floor(Date.now() / 1000) + 3600 };
    let captured = "";
    const fakeRes = { cookie: (name: string, value: string) => (captured = `${name}=${value}`) } as unknown as Response;
    sessions.issue(fakeRes, payload);
    return captured;
  }

  async function setupDoctorWithApprovedCredential(subject: string, specialty: string): Promise<void> {
    await request(app.getHttpServer())
      .put("/doctors/me/profile")
      .set("Cookie", cookieFor(subject))
      .send({ crmNumber: `CRM-${randomUUID()}`, specialties: [specialty] });
    const submitRes = await request(app.getHttpServer())
      .post("/doctors/me/credentials")
      .set("Cookie", cookieFor(subject))
      .send({ organizationId: orgA.id, evidenceUrl: "https://files.example.com/crm.pdf" });
    await request(app.getHttpServer())
      .post(`/credentials/${submitRes.body.id}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "CRM conferido" });
  }

  async function draftAndPublishShift(specialty: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const draftRes = await request(app.getHttpServer())
      .post("/shifts")
      .set("Cookie", cookieFor(adminA.subject))
      .send({
        specialty,
        valueCents: 50000,
        startsAt: "2026-09-01T08:00:00Z",
        endsAt: "2026-09-01T16:00:00Z",
        ...overrides,
      });
    const shiftId = draftRes.body.id as string;
    await request(app.getHttpServer()).post(`/shifts/${shiftId}/publish`).set("Cookie", cookieFor(adminA.subject));
    return shiftId;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    sessions = moduleRef.get(SessionService);
    tenantContext = moduleRef.get(TenantContextService);
    worker = moduleRef.get(NotificationWorkerService);
    worker.configure({ queueName: `notifications-inapp-test-${randomUUID()}`, maxAttempts: 3, backoffMs: 20, intervalMs: 0 });
    await worker.start();

    orgA = await prisma.organization.create({ data: { name: `Hospital InApp ${randomUUID()}`, timezone: "America/Sao_Paulo" } });
    const adminAUserRow = await prisma.user.create({
      data: { oidcSubject: adminA.subject, email: adminA.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgA.id },
    });
    adminAUser = adminAUserRow;
    createdUserIds.push(adminAUserRow.id);

    const doctorUsers = await Promise.all([
      prisma.user.create({ data: { oidcSubject: doctorCardio.subject, email: doctorCardio.email, role: UserRole.DOCTOR } }),
      prisma.user.create({ data: { oidcSubject: doctorOrtho.subject, email: doctorOrtho.email, role: UserRole.DOCTOR } }),
    ]);
    createdUserIds.push(...doctorUsers.map((u) => u.id));

    await setupDoctorWithApprovedCredential(doctorCardio.subject, "Cardiologia");
    await setupDoctorWithApprovedCredential(doctorOrtho.subject, "Ortopedia");
  });

  afterAll(async () => {
    await worker.stop();
    const admin = createAdminPrismaForTestCleanup();
    await admin.notification.deleteMany({ where: { organizationId: orgA.id } });
    await admin.emailDelivery.deleteMany({ where: { organizationId: orgA.id } });
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

  it("shift.published notifica só o médico com especialidade compatível E credencial aprovada (fan-out seletivo)", async () => {
    const shiftId = await draftAndPublishShift("Cardiologia", {
      startsAt: "2026-09-02T08:00:00Z",
      endsAt: "2026-09-02T16:00:00Z",
    });
    await worker.pollOnce([orgA.id]);

    const cardioProfile = await prisma.doctorProfile.findFirstOrThrow({ where: { user: { oidcSubject: doctorCardio.subject } } });
    const orthoProfile = await prisma.doctorProfile.findFirstOrThrow({ where: { user: { oidcSubject: doctorOrtho.subject } } });

    await waitFor(async () => {
      const list = await request(app.getHttpServer()).get("/notifications").set("Cookie", cookieFor(doctorCardio.subject));
      return list.body.items.some((n: { payload: { shiftId?: string } }) => n.payload.shiftId === shiftId);
    }, 5000);

    const cardioList = await request(app.getHttpServer()).get("/notifications").set("Cookie", cookieFor(doctorCardio.subject));
    const orthoList = await request(app.getHttpServer()).get("/notifications").set("Cookie", cookieFor(doctorOrtho.subject));

    expect(cardioList.body.items.some((n: { payload: { shiftId?: string } }) => n.payload.shiftId === shiftId)).toBe(true);
    expect(orthoList.body.items.some((n: { payload: { shiftId?: string } }) => n.payload.shiftId === shiftId)).toBe(false);
    void cardioProfile;
    void orthoProfile;
  });

  it("payload da notificação não inclui justificativa nem evidência de credencial (sem dado sensível)", async () => {
    const shiftId = await draftAndPublishShift("Cardiologia", {
      startsAt: "2026-09-03T08:00:00Z",
      endsAt: "2026-09-03T16:00:00Z",
    });
    await worker.pollOnce([orgA.id]);

    await waitFor(async () => {
      const list = await request(app.getHttpServer()).get("/notifications").set("Cookie", cookieFor(doctorCardio.subject));
      return list.body.items.some((n: { payload: { shiftId?: string } }) => n.payload.shiftId === shiftId);
    }, 5000);

    const list = await request(app.getHttpServer()).get("/notifications").set("Cookie", cookieFor(doctorCardio.subject));
    const notification = list.body.items.find((n: { payload: { shiftId?: string } }) => n.payload.shiftId === shiftId);
    const serialized = JSON.stringify(notification.payload).toLowerCase();
    expect(serialized).not.toContain("justificat");
    expect(serialized).not.toContain("evidence");
    expect(serialized).not.toContain("crm.pdf");
  });

  it("application.decided notifica só o médico candidato, com a decisão mas sem justificativa", async () => {
    const shiftId = await draftAndPublishShift("Cardiologia", {
      startsAt: "2026-09-04T08:00:00Z",
      endsAt: "2026-09-04T16:00:00Z",
    });
    const applyRes = await request(app.getHttpServer())
      .post("/applications")
      .set("Cookie", cookieFor(doctorCardio.subject))
      .send({ shiftId, organizationId: orgA.id });
    const applicationId = applyRes.body.id as string;

    await request(app.getHttpServer())
      .post(`/applications/${applicationId}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "Segredo administrativo interno" });

    await worker.pollOnce([orgA.id]);

    await waitFor(async () => {
      const list = await request(app.getHttpServer()).get("/notifications").set("Cookie", cookieFor(doctorCardio.subject));
      return list.body.items.some((n: { type: string; payload: { applicationId?: string } }) => n.type === "application.decided" && n.payload.applicationId === applicationId);
    }, 5000);

    const cardioList = await request(app.getHttpServer()).get("/notifications").set("Cookie", cookieFor(doctorCardio.subject));
    const notification = cardioList.body.items.find((n: { payload: { applicationId?: string } }) => n.payload.applicationId === applicationId);
    expect(notification.payload.decision).toBe("APPROVED");
    expect(JSON.stringify(notification.payload)).not.toContain("Segredo administrativo interno");

    const orthoList = await request(app.getHttpServer()).get("/notifications").set("Cookie", cookieFor(doctorOrtho.subject));
    expect(orthoList.body.items.some((n: { payload: { applicationId?: string } }) => n.payload.applicationId === applicationId)).toBe(false);
  });

  it("médico só lê as próprias notificações mesmo tentando escopo de outro usuário diretamente no serviço (RLS)", async () => {
    const shiftId = await draftAndPublishShift("Cardiologia", {
      startsAt: "2026-09-05T08:00:00Z",
      endsAt: "2026-09-05T16:00:00Z",
    });
    await worker.pollOnce([orgA.id]);
    await waitFor(async () => {
      const list = await request(app.getHttpServer()).get("/notifications").set("Cookie", cookieFor(doctorCardio.subject));
      return list.body.items.some((n: { payload: { shiftId?: string } }) => n.payload.shiftId === shiftId);
    }, 5000);

    const cardioUser = await prisma.user.findUniqueOrThrow({ where: { oidcSubject: doctorCardio.subject } });
    const notificationRow = await tenantContext.withNotificationRecipientScope(cardioUser.id, (tx) =>
      tx.notification.findFirst({ where: { userId: cardioUser.id } }),
    );
    expect(notificationRow).toBeTruthy();

    // Um usuário SEM relação com a notificação (o próprio admin, que
    // não é o destinatário) não a enxerga mesmo com uma transação
    // aberta -- confere que a política é por user_id, não por
    // organização (tenant_isolation isolado não bastaria aqui, já
    // que o admin está na mesma org).
    const orthoUser = await prisma.user.findUniqueOrThrow({ where: { oidcSubject: doctorOrtho.subject } });
    const asOrtho = await tenantContext.withNotificationRecipientScope(orthoUser.id, (tx) =>
      tx.notification.findUnique({ where: { id: notificationRow!.id } }),
    );
    expect(asOrtho).toBeNull();
  });

  it("marcação de leitura é idempotente", async () => {
    const shiftId = await draftAndPublishShift("Cardiologia", {
      startsAt: "2026-09-06T08:00:00Z",
      endsAt: "2026-09-06T16:00:00Z",
    });
    await worker.pollOnce([orgA.id]);
    await waitFor(async () => {
      const list = await request(app.getHttpServer()).get("/notifications").set("Cookie", cookieFor(doctorCardio.subject));
      return list.body.items.some((n: { payload: { shiftId?: string } }) => n.payload.shiftId === shiftId);
    }, 5000);

    const before = await request(app.getHttpServer()).get("/notifications").set("Cookie", cookieFor(doctorCardio.subject));
    const target = before.body.items.find((n: { payload: { shiftId?: string } }) => n.payload.shiftId === shiftId);

    const first = await request(app.getHttpServer()).post(`/notifications/${target.id}/read`).set("Cookie", cookieFor(doctorCardio.subject));
    expect(first.status).toBe(201);
    const afterFirst = await request(app.getHttpServer()).get("/notifications").set("Cookie", cookieFor(doctorCardio.subject));
    const readAtAfterFirst = afterFirst.body.items.find((n: { id: string }) => n.id === target.id).readAt;
    expect(readAtAfterFirst).toBeTruthy();

    const second = await request(app.getHttpServer()).post(`/notifications/${target.id}/read`).set("Cookie", cookieFor(doctorCardio.subject));
    expect(second.status).toBe(201);
    const afterSecond = await request(app.getHttpServer()).get("/notifications").set("Cookie", cookieFor(doctorCardio.subject));
    const readAtAfterSecond = afterSecond.body.items.find((n: { id: string }) => n.id === target.id).readAt;
    expect(readAtAfterSecond).toBe(readAtAfterFirst);
  });

  it("listagem é paginada e contagem de não lidas está presente", async () => {
    for (let i = 0; i < 3; i += 1) {
      await draftAndPublishShift("Cardiologia", {
        startsAt: `2026-09-1${i}T08:00:00Z`,
        endsAt: `2026-09-1${i}T16:00:00Z`,
      });
    }
    await worker.pollOnce([orgA.id]);
    await waitFor(async () => {
      const list = await request(app.getHttpServer()).get("/notifications?page=1&pageSize=1").set("Cookie", cookieFor(doctorCardio.subject));
      return list.body.total >= 4;
    }, 5000);

    const page1 = await request(app.getHttpServer()).get("/notifications?page=1&pageSize=1").set("Cookie", cookieFor(doctorCardio.subject));
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.page).toBe(1);
    expect(page1.body.pageSize).toBe(1);
    expect(page1.body.total).toBeGreaterThanOrEqual(4);
    expect(typeof page1.body.unreadCount).toBe("number");

    const page2 = await request(app.getHttpServer()).get("/notifications?page=2&pageSize=1").set("Cookie", cookieFor(doctorCardio.subject));
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
  });

  it("reprocessamento do mesmo evento não duplica a notificação (idempotência via sourceOutboxEventId + userId)", async () => {
    const shiftId = await draftAndPublishShift("Cardiologia", {
      startsAt: "2026-09-20T08:00:00Z",
      endsAt: "2026-09-20T16:00:00Z",
    });
    await worker.pollOnce([orgA.id]);
    await waitFor(async () => {
      const row = await tenantContext.withTenantScope(orgA.id, (tx) =>
        tx.outboxEvent.findMany({ where: { organizationId: orgA.id, eventType: "shift.published" } }).then((rows) =>
          rows.find((r) => (r.payload as Record<string, unknown>).shiftId === shiftId),
        ),
      );
      return row?.status === "COMPLETED";
    }, 5000);

    const cardioUser = await prisma.user.findUniqueOrThrow({ where: { oidcSubject: doctorCardio.subject } });
    const countBefore = await tenantContext.withNotificationRecipientScope(cardioUser.id, (tx) =>
      tx.notification.count({ where: { userId: cardioUser.id } }),
    );

    // Simula reprocessamento: pega o evento já COMPLETED e chama o
    // handler de novo diretamente, como se um retry tivesse
    // reexecutado todos os handlers do job (cenário real: um handler
    // IRMÃO falha e o BullMQ reprocessa o job inteiro).
    const event = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.outboxEvent.findFirst({ where: { organizationId: orgA.id, eventType: "shift.published", status: "COMPLETED" } }),
    );
    expect(event).toBeTruthy();

    await tenantContext.withTenantScope(orgA.id, async (tx) => {
      // new InAppService(...) sem passar por Nest DI não dispara
      // onModuleInit() -- não registra handlers extras no worker
      // compartilhado. Só reaproveita create(), chamando-a de novo
      // com o mesmo sourceOutboxEventId, exatamente como um handler
      // real faria se o job fosse reprocessado por um retry do
      // BullMQ (ex.: um handler IRMÃO falhou e o job inteiro repete).
      const service = new InAppService(tenantContext, worker);
      await service.create(tx, {
        organizationId: orgA.id,
        userId: cardioUser.id,
        type: "shift.published",
        payload: event!.payload as Prisma.InputJsonValue,
        sourceOutboxEventId: event!.id,
      });
    });

    const countAfter = await tenantContext.withNotificationRecipientScope(cardioUser.id, (tx) =>
      tx.notification.count({ where: { userId: cardioUser.id } }),
    );
    expect(countAfter).toBe(countBefore);
  });
});
