import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { TenantContextService } from "../../src/organizations/tenant-context";
import { OutboxService } from "../../src/notifications/outbox.service";
import { NotificationWorkerService } from "../../src/notifications/notification.worker";
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

describe("NotificationWorkerService (integração — T-5.1.2, requer Redis local)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantContext: TenantContextService;
  let outbox: OutboxService;
  let worker: NotificationWorkerService;

  let orgA: { id: string };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = moduleRef.get(PrismaService);
    tenantContext = moduleRef.get(TenantContextService);
    outbox = moduleRef.get(OutboxService);
    worker = moduleRef.get(NotificationWorkerService);

    orgA = await prisma.organization.create({ data: { name: `Hospital Worker ${randomUUID()}`, timezone: "America/Sao_Paulo" } });

    // Fila isolada por execução de teste + números pequenos para não
    // depender de tempo real de produção (retry/backoff em segundos).
    worker.configure({ queueName: `notifications-test-${randomUUID()}`, maxAttempts: 2, backoffMs: 20, intervalMs: 0, batchSize: 20 });
    await worker.start();
  });

  afterAll(async () => {
    await worker.stop();
    const admin = createAdminPrismaForTestCleanup();
    await admin.outboxEvent.deleteMany({ where: { organizationId: orgA.id } });
    await admin.$disconnect();
    await prisma.organization.deleteMany({ where: { id: orgA.id } });
    await app.close();
  });

  async function enqueueEvent(marker: string): Promise<void> {
    await tenantContext.withTenantScope(orgA.id, (tx) =>
      outbox.enqueue(tx, orgA.id, "shift.published", { version: 1, shiftId: marker, specialty: "Cardiologia" }),
    );
  }

  async function findEventByMarker(marker: string) {
    return tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.outboxEvent.findMany({ where: { organizationId: orgA.id } }).then((rows) =>
        rows.find((row) => (row.payload as Record<string, unknown>).shiftId === marker),
      ),
    );
  }

  it("processa um evento PENDING até COMPLETED e chama o handler exatamente uma vez", async () => {
    const marker = `worker-success-${randomUUID()}`;
    let callCount = 0;
    worker.registerHandler("shift.published", async () => {
      callCount += 1;
    });

    await enqueueEvent(marker);
    const claimed = await worker.pollOnce([orgA.id]);
    expect(claimed).toBeGreaterThanOrEqual(1);

    await waitFor(async () => {
      const row = await findEventByMarker(marker);
      return row?.status === "COMPLETED";
    }, 5000);

    expect(callCount).toBe(1);
  });

  it("reprocessamento não duplica o efeito lógico: job duplicado para evento já COMPLETED é no-op", async () => {
    const marker = `worker-idempotent-${randomUUID()}`;
    let callCount = 0;
    worker.registerHandler("shift.published", async () => {
      callCount += 1;
    });

    await enqueueEvent(marker);
    await worker.pollOnce([orgA.id]);
    await waitFor(async () => (await findEventByMarker(marker))?.status === "COMPLETED", 5000);
    expect(callCount).toBe(1);

    // Reivindicar de novo não encontra nada (não está mais PENDING) --
    // a garantia primária de idempotência é a própria transição de
    // estado da outbox.
    const reclaimed = await worker.pollOnce([orgA.id]);
    const eventAfterReclaim = await findEventByMarker(marker);
    expect(callCount).toBe(1);
    expect(eventAfterReclaim?.status).toBe("COMPLETED");
    void reclaimed;

    // Prova mais direta: mesmo se um job duplicado for reenfileirado
    // manualmente para o MESMO outboxEventId (ex.: redelivery), o
    // processor confere o status atual no banco antes de chamar o
    // handler -- já não está mais PROCESSING, então é um no-op.
    const event = await findEventByMarker(marker);
    expect(event).toBeDefined();
    const queueInternal = (worker as unknown as { queue?: { add: (name: string, data: unknown, opts: unknown) => Promise<unknown> } }).queue;
    expect(queueInternal).toBeDefined();
    await queueInternal!.add(
      "shift.published",
      { outboxEventId: event!.id, organizationId: orgA.id, eventType: "shift.published" },
      { jobId: event!.id, attempts: 1, removeOnComplete: true, removeOnFail: true },
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(callCount).toBe(1);
    const finalEvent = await findEventByMarker(marker);
    expect(finalEvent?.status).toBe("COMPLETED");
  });

  it("falha esgotada move o evento para DEAD_LETTER, observável via OutboxService.listDeadLetter", async () => {
    const marker = `worker-dead-letter-${randomUUID()}`;
    worker.registerHandler("shift.published", async () => {
      throw new Error("falha proposital de teste");
    });

    await enqueueEvent(marker);
    await worker.pollOnce([orgA.id]);

    await waitFor(async () => (await findEventByMarker(marker))?.status === "DEAD_LETTER", 5000);

    const event = await findEventByMarker(marker);
    expect(event?.status).toBe("DEAD_LETTER");
    expect(event?.lastError).toContain("falha proposital de teste");
    expect(event?.attempts).toBe(2);

    const deadLetters = await tenantContext.withTenantScope(orgA.id, (tx) => outbox.listDeadLetter(tx, orgA.id));
    expect(deadLetters.some((row) => row.id === event!.id)).toBe(true);
  });

  it("evento com eventType sem nenhum handler registrado também esgota tentativas e vai para DEAD_LETTER (nenhum evento fica órfão silenciosamente)", async () => {
    // "shift.published" e "application.decided" sempre têm handler
    // real registrado por InAppService (T-5.1.3), então este teste
    // usa um eventType sintético (inserido direto via Prisma,
    // contornando o union de tipos fechado de OutboxService.enqueue)
    // para provar a garantia genérica do worker: qualquer eventType
    // sem handler dead-letra, nunca fica pendente para sempre em
    // silêncio.
    const marker = `worker-no-handler-${randomUUID()}`;
    await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.outboxEvent.create({
        data: { organizationId: orgA.id, eventType: "test.unregistered-event-type", payload: { shiftId: marker } },
      }),
    );
    await worker.pollOnce([orgA.id]);

    await waitFor(async () => {
      const row = await tenantContext.withTenantScope(orgA.id, (tx) =>
        tx.outboxEvent.findMany({ where: { organizationId: orgA.id, eventType: "test.unregistered-event-type" } }).then((rows) =>
          rows.find((r) => (r.payload as Record<string, unknown>).shiftId === marker),
        ),
      );
      return row?.status === "DEAD_LETTER";
    }, 5000);
  });
});
