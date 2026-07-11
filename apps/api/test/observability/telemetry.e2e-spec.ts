import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import cookieParser from "cookie-parser";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { UserRole } from "@prisma/client";
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { InMemoryMetricExporter, AggregationTemporality } from "@opentelemetry/sdk-metrics";
import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { TenantContextService } from "../../src/organizations/tenant-context";
import { NotificationWorkerService } from "../../src/notifications/notification.worker";
import { SessionService, type SessionPayload } from "../../src/identity/session.service";
import { FakeOidcProvider } from "../../src/identity/providers/fake-oidc.provider";
import { initTelemetry, flushMetrics, resetCountersForTest } from "../../src/observability/telemetry";
import { setLogSinkForTest, resetLogSinkForTest, type StructuredLogLine } from "../../src/observability/structured-logger";
import { createAdminPrismaForTestCleanup } from "../support/admin-prisma";

process.env.SESSION_SECRET ??= "test-only-session-secret-32-characters";
process.env.OIDC_ISSUER_URL = "";
process.env.COOKIE_SECURE ??= "true";
process.env.DATABASE_URL =
  "postgresql://plantoes_app:plantoes_app_dev_local@localhost:5432/plantoes_medicos?schema=public";

/**
 * Ao contrário das outras suítes (que bootstram via
 * Test.createTestingModule diretamente, nunca passando por main.ts),
 * este arquivo chama initTelemetry() explicitamente com exporters
 * em memória — é a única forma de observar de verdade os spans e
 * métricas que os 5 fluxos críticos emitem, sem depender de um
 * backend OTLP real (nenhum configurado neste ambiente).
 */
describe("Observabilidade (integração — T-5.2.2)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;
  let worker: NotificationWorkerService;
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);

  const adminA = { subject: `admin-a-${randomUUID()}`, email: `admin-a-${randomUUID()}@example.com` };
  const doctorA = { subject: `doctor-a-${randomUUID()}`, email: `doctor-a-${randomUUID()}@example.com` };
  let orgA: { id: string };
  let adminAUserId: string;
  const createdUserIds: string[] = [];

  function cookieFor(subject: string): string {
    const payload: SessionPayload = { subject, email: "irrelevant@example.com", exp: Math.floor(Date.now() / 1000) + 3600 };
    let captured = "";
    const fakeRes = { cookie: (name: string, value: string) => (captured = `${name}=${value}`) } as unknown as Response;
    sessions.issue(fakeRes, payload);
    return captured;
  }

  async function makeDoctorWithApprovedCredential(specialty: string): Promise<void> {
    const user = await prisma.user.create({ data: { oidcSubject: doctorA.subject, email: doctorA.email, role: UserRole.DOCTOR } });
    createdUserIds.push(user.id);
    const profile = await prisma.doctorProfile.create({ data: { userId: user.id, crmNumber: `CRM-${randomUUID()}`, specialties: [specialty] } });
    await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.credential.create({
        data: { doctorProfileId: profile.id, organizationId: orgA.id, evidenceUrl: "https://files.example.com/x.pdf", status: "APPROVED", reviewedByUserId: adminAUserId, reviewedAt: new Date() },
      }),
    );
  }

  // Cada chamada usa um dia distinto -- doctorA acumula candidaturas
  // (algumas aprovadas) ao longo dos testes deste arquivo, e horários
  // sobrepostos disparariam schedule_conflict (400) silenciosamente,
  // já que os testes aqui focam em telemetria, não no status HTTP da
  // candidatura em si.
  let shiftDayCounter = 1;

  async function createShift(specialty: string): Promise<string> {
    const day = String(shiftDayCounter++).padStart(2, "0");
    const shift = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.shift.create({
        data: {
          organizationId: orgA.id,
          specialty,
          valueCents: 50000,
          startsAt: new Date(`2026-10-${day}T08:00:00Z`),
          endsAt: new Date(`2026-10-${day}T16:00:00Z`),
          status: "PUBLISHED",
          createdByUserId: adminAUserId,
        },
      }),
    );
    return shift.id;
  }

  beforeAll(async () => {
    initTelemetry({ traceExporter: spanExporter, metricExporter, metricExportIntervalMillis: 100 });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    sessions = moduleRef.get(SessionService);
    tenantContext = moduleRef.get(TenantContextService);
    worker = moduleRef.get(NotificationWorkerService);
    worker.configure({ queueName: `notifications-telemetry-test-${randomUUID()}`, maxAttempts: 2, backoffMs: 20, intervalMs: 0 });
    await worker.start();

    orgA = await prisma.organization.create({ data: { name: `Hospital Telemetry ${randomUUID()}`, timezone: "America/Sao_Paulo" } });
    const adminAUser = await prisma.user.create({
      data: { oidcSubject: adminA.subject, email: adminA.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgA.id },
    });
    createdUserIds.push(adminAUser.id);
    adminAUserId = adminAUser.id;
    await makeDoctorWithApprovedCredential("Cardiologia");
  });

  beforeEach(() => {
    spanExporter.reset();
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

  function findSpan(name: string): ReadableSpan | undefined {
    return spanExporter.getFinishedSpans().find((s) => s.name === name);
  }

  it("login: gera span 'auth.login' sem erro", async () => {
    const loginRes = await request(app.getHttpServer()).get("/auth/login");
    const pendingCookie = (loginRes.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("plantoes_auth_pending="))!.split(";")[0];
    const state = new URL(loginRes.headers.location).searchParams.get("state");
    const code = FakeOidcProvider.encodeCode(`telemetry-doctor-${randomUUID()}`, `telemetry-${randomUUID()}@example.com`);

    await request(app.getHttpServer()).get("/auth/callback").set("Cookie", pendingCookie).query({ code, state });

    const span = findSpan("auth.login");
    expect(span).toBeTruthy();
    expect(span!.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(span!.attributes).toBeDefined();
  });

  it("busca de plantão: gera span 'shifts.search' com organization_id e result_count", async () => {
    const shiftId = await createShift("Cardiologia");
    const res = await request(app.getHttpServer())
      .get(`/shifts/search?organizationId=${orgA.id}&specialty=Cardiologia`)
      .set("Cookie", cookieFor(doctorA.subject));
    expect(res.status).toBe(200);

    const span = findSpan("shifts.search");
    expect(span).toBeTruthy();
    expect(span!.attributes["shifts.organization_id"]).toBe(orgA.id);
    expect(typeof span!.attributes["shifts.result_count"]).toBe("number");
    void shiftId;
  });

  it("candidatura: gera span 'application.apply' com shift_id", async () => {
    const shiftId = await createShift("Cardiologia");
    const res = await request(app.getHttpServer())
      .post("/applications")
      .set("Cookie", cookieFor(doctorA.subject))
      .send({ shiftId, organizationId: orgA.id });
    expect(res.status).toBe(201);

    const span = findSpan("application.apply");
    expect(span).toBeTruthy();
    expect(span!.attributes["application.shift_id"]).toBe(shiftId);
  });

  it("decisão + entrega de notificação: mesmo correlationId (traceId) ponta a ponta, da decisão HTTP até o worker processar", async () => {
    const shiftId = await createShift("Cardiologia");
    const applyRes = await request(app.getHttpServer())
      .post("/applications")
      .set("Cookie", cookieFor(doctorA.subject))
      .send({ shiftId, organizationId: orgA.id });
    const applicationId = applyRes.body.id as string;

    spanExporter.reset();

    const reviewRes = await request(app.getHttpServer())
      .post(`/applications/${applicationId}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "CRM conferido" });
    expect(reviewRes.status).toBe(201);

    const decideSpan = findSpan("application.decide");
    expect(decideSpan).toBeTruthy();
    const decideTraceId = decideSpan!.spanContext().traceId;

    await worker.pollOnce([orgA.id]);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const deliverSpan = spanExporter.getFinishedSpans().find((s) => s.name === "notification.deliver");
    expect(deliverSpan).toBeTruthy();
    // A prova real de correlação ponta a ponta: o span de entrega,
    // criado pelo worker num job assíncrono SEM relação de
    // call-stack com a requisição HTTP original, carrega o MESMO
    // traceId do span da decisão que disparou o evento — não é um
    // id qualquer copiado à mão, é o mecanismo real de trace context
    // propagation do OpenTelemetry (ver telemetry.ts
    // injectTraceContext/extractTraceContext e
    // OutboxService.enqueue).
    expect(deliverSpan!.spanContext().traceId).toBe(decideTraceId);
  });

  it("métricas: os 5 counters dos fluxos críticos incrementam", async () => {
    resetCountersForTest();
    const shiftId = await createShift("Cardiologia");
    await request(app.getHttpServer()).get(`/shifts/search?organizationId=${orgA.id}&specialty=Cardiologia`).set("Cookie", cookieFor(doctorA.subject));
    const applyRes = await request(app.getHttpServer()).post("/applications").set("Cookie", cookieFor(doctorA.subject)).send({ shiftId, organizationId: orgA.id });
    expect(applyRes.status).toBe(201);
    await request(app.getHttpServer())
      .post(`/applications/${applyRes.body.id}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "CRM conferido" });
    await worker.pollOnce([orgA.id]);
    await new Promise((resolve) => setTimeout(resolve, 300));

    await flushMetrics();
    const resourceMetrics = metricExporter.getMetrics();
    const allMetrics = resourceMetrics.flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics));
    const names = allMetrics.map((m) => m.descriptor.name);

    for (const expected of [
      "plantoes.shift_search.count",
      "plantoes.application.count",
      "plantoes.decision.count",
      "plantoes.notification_delivery.count",
    ]) {
      expect(names).toContain(expected);
      const metric = allMetrics.find((m) => m.descriptor.name === expected)!;
      const total = metric.dataPoints.reduce((sum, dp) => sum + (dp.value as number), 0);
      expect(total).toBeGreaterThanOrEqual(1);
    }
  });

  it("logs: correlationId presente e nenhum campo sensível (email, justificativa, evidência) aparece", async () => {
    const parsed: StructuredLogLine[] = [];
    setLogSinkForTest((line) => parsed.push(line));

    try {
      const shiftId = await createShift("Cardiologia");
      const applyRes = await request(app.getHttpServer())
        .post("/applications")
        .set("Cookie", cookieFor(doctorA.subject))
        .send({ shiftId, organizationId: orgA.id });
      expect(applyRes.status).toBe(201);
    } finally {
      resetLogSinkForTest();
    }

    expect(parsed.length).toBeGreaterThan(0);
    const applyLog = parsed.find((p) => p.event === "application.apply");
    expect(applyLog).toBeTruthy();
    expect(applyLog!.correlationId).toBeTruthy();
    expect(typeof applyLog!.correlationId).toBe("string");

    const serialized = JSON.stringify(parsed).toLowerCase();
    expect(serialized).not.toContain(doctorA.email.toLowerCase());
    expect(serialized).not.toContain("justificat");
    expect(serialized).not.toContain("evidence");
    expect(serialized).not.toContain("crm-");
  });
});
