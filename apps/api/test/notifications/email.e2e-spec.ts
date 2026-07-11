import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
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
import { NotificationWorkerService } from "../../src/notifications/notification.worker";
import { EmailAdapter, type EmailMessage, type EmailProvider, type EmailSendResult } from "../../src/notifications/email.adapter";
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

class RecordingEmailProvider implements EmailProvider {
  sent: EmailMessage[] = [];
  private failNextCalls = 0;

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (this.failNextCalls > 0) {
      this.failNextCalls -= 1;
      return { delivered: false };
    }
    this.sent.push(message);
    return { delivered: true, providerMessageId: `test-${randomUUID()}` };
  }

  failNext(times: number): void {
    this.failNextCalls = times;
  }
}

describe("EmailAdapter (integração — T-5.1.4)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;
  let worker: NotificationWorkerService;
  let emailAdapter: EmailAdapter;
  let provider: RecordingEmailProvider;

  const adminA = { subject: `admin-a-${randomUUID()}`, email: `admin-a-${randomUUID()}@example.com` };
  const doctorA = { subject: `doctor-a-${randomUUID()}`, email: `doctor-a-${randomUUID()}@example.com` };
  const doctorOptOut = { subject: `doctor-optout-${randomUUID()}`, email: `doctor-optout-${randomUUID()}@example.com` };
  let orgA: { id: string };
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
      .send({ specialty, valueCents: 50000, startsAt: "2026-09-01T08:00:00Z", endsAt: "2026-09-01T16:00:00Z", ...overrides });
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
    emailAdapter = moduleRef.get(EmailAdapter);

    worker.configure({ queueName: `notifications-email-test-${randomUUID()}`, maxAttempts: 3, backoffMs: 20, intervalMs: 0 });
    await worker.start();

    orgA = await prisma.organization.create({ data: { name: `Hospital Email ${randomUUID()}`, timezone: "America/Sao_Paulo" } });
    const adminAUser = await prisma.user.create({
      data: { oidcSubject: adminA.subject, email: adminA.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgA.id },
    });
    createdUserIds.push(adminAUser.id);

    const doctorUsers = await Promise.all([
      prisma.user.create({ data: { oidcSubject: doctorA.subject, email: doctorA.email, role: UserRole.DOCTOR } }),
      prisma.user.create({ data: { oidcSubject: doctorOptOut.subject, email: doctorOptOut.email, role: UserRole.DOCTOR, emailOptOut: true } }),
    ]);
    createdUserIds.push(...doctorUsers.map((u) => u.id));

    await setupDoctorWithApprovedCredential(doctorA.subject, "Cardiologia");
    await setupDoctorWithApprovedCredential(doctorOptOut.subject, "Cardiologia");
  });

  beforeEach(() => {
    provider = new RecordingEmailProvider();
    emailAdapter.setProvider(provider);
  });

  async function outboxEventIdForShift(shiftId: string): Promise<string> {
    const event = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.outboxEvent.findMany({ where: { organizationId: orgA.id, eventType: "shift.published" } }).then((rows) =>
        rows.find((r) => (r.payload as Record<string, unknown>).shiftId === shiftId),
      ),
    );
    if (!event) throw new Error(`Nenhum outbox event encontrado para shiftId=${shiftId}`);
    return event.id;
  }

  afterAll(async () => {
    await worker.stop();
    const admin = createAdminPrismaForTestCleanup();
    await admin.emailDelivery.deleteMany({ where: { organizationId: orgA.id } });
    await admin.notification.deleteMany({ where: { organizationId: orgA.id } });
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

  it("provider é trocável em runtime sem alterar chamadores (setProvider)", async () => {
    await draftAndPublishShift("Cardiologia", { startsAt: "2026-09-02T08:00:00Z", endsAt: "2026-09-02T16:00:00Z" });
    await worker.pollOnce([orgA.id]);

    await waitFor(async () => provider.sent.some((m) => m.to === doctorA.email), 5000);
    expect(provider.sent.some((m) => m.to === doctorA.email)).toBe(true);
  });

  it("assunto do email não contém dado sensível (PII)", async () => {
    await draftAndPublishShift("Cardiologia", { startsAt: "2026-09-03T08:00:00Z", endsAt: "2026-09-03T16:00:00Z" });
    await worker.pollOnce([orgA.id]);
    await waitFor(async () => provider.sent.some((m) => m.to === doctorA.email), 5000);

    const message = provider.sent.find((m) => m.to === doctorA.email)!;
    expect(message.subject.toLowerCase()).not.toContain("crm");
    expect(message.subject.toLowerCase()).not.toContain(doctorA.email.toLowerCase());
    expect(message.subject).not.toContain("@");
  });

  it("opt-out é respeitado antes do envio: médico com emailOptOut nunca recebe email", async () => {
    const shiftId = await draftAndPublishShift("Cardiologia", { startsAt: "2026-09-04T08:00:00Z", endsAt: "2026-09-04T16:00:00Z" });
    await worker.pollOnce([orgA.id]);
    await waitFor(async () => provider.sent.some((m) => m.to === doctorA.email), 5000);

    // Dá tempo para qualquer envio indevido ao opt-out aparecer (não
    // há mais nada para esperar de propósito, só uma janela curta).
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(provider.sent.some((m) => m.to === doctorOptOut.email)).toBe(false);
    const optOutUser = await prisma.user.findUniqueOrThrow({ where: { oidcSubject: doctorOptOut.subject } });
    const delivery = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.emailDelivery.findMany({ where: { organizationId: orgA.id, userId: optOutUser.id } }),
    );
    expect(delivery).toHaveLength(0);
    void shiftId;
  });

  it("falha no envio não grava EmailDelivery (retry legítimo tenta de novo)", async () => {
    provider.failNext(1);
    const shiftId = await draftAndPublishShift("Cardiologia", { startsAt: "2026-09-05T08:00:00Z", endsAt: "2026-09-05T16:00:00Z" });
    await worker.pollOnce([orgA.id]);

    await waitFor(async () => provider.sent.some((m) => m.to === doctorA.email), 5000);

    const eventId = await outboxEventIdForShift(shiftId);
    const deliveries = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.emailDelivery.findMany({ where: { organizationId: orgA.id, sourceOutboxEventId: eventId } }),
    );
    // Exatamente uma entrega confirmada para ESTE evento (a tentativa que falhou não deixou linha nenhuma).
    expect(deliveries).toHaveLength(1);
  });

  it("retry não reenvia email já confirmado como entregue, mesmo quando o job inteiro é reprocessado por falha de um handler irmão", async () => {
    // Cenário real: EmailAdapter e InAppService (e aqui, um terceiro
    // handler de teste) rodam no MESMO job/transação. Se o terceiro
    // handler falhar DEPOIS do EmailAdapter já ter enviado o email
    // com sucesso, o job inteiro falha e o BullMQ reprocessa TODOS os
    // handlers de novo -- o evento continua PROCESSING (nunca chegou
    // a COMPLETED), então o guard de nível worker (que só pula
    // handlers se status != PROCESSING) NÃO bloqueia a re-execução.
    // A prova real de idempotência tem que vir do próprio
    // EmailAdapter (checagem de EmailDelivery já existente).
    let siblingCalls = 0;
    worker.registerHandler("shift.published", async () => {
      siblingCalls += 1;
      if (siblingCalls === 1) {
        throw new Error("falha proposital do handler irmão (primeira tentativa)");
      }
    });

    const shiftId = await draftAndPublishShift("Cardiologia", { startsAt: "2026-09-07T08:00:00Z", endsAt: "2026-09-07T16:00:00Z" });
    await worker.pollOnce([orgA.id]);

    await waitFor(async () => {
      const row = await tenantContext.withTenantScope(orgA.id, (tx) =>
        tx.outboxEvent.findMany({ where: { organizationId: orgA.id, eventType: "shift.published" } }).then((rows) =>
          rows.find((r) => (r.payload as Record<string, unknown>).shiftId === shiftId),
        ),
      );
      return row?.status === "COMPLETED";
    }, 5000);

    expect(siblingCalls).toBe(2);
    const sentCountForDoctorA = provider.sent.filter((m) => m.to === doctorA.email).length;
    expect(sentCountForDoctorA).toBe(1);

    const eventId = await outboxEventIdForShift(shiftId);
    const deliveries = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.emailDelivery.findMany({ where: { organizationId: orgA.id, sourceOutboxEventId: eventId } }),
    );
    expect(deliveries).toHaveLength(1);
  });
});
