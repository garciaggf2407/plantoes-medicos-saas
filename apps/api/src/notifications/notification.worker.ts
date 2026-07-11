import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../organizations/tenant-context";
import type { OutboxEventPayload, StoredEventPayload } from "./outbox.service";
import { telemetry, withSpan, extractTraceContext } from "../observability/telemetry";
import { logEvent } from "../observability/structured-logger";

export interface NotificationHandlerContext {
  organizationId: string;
  outboxEventId: string;
  // Mesma transação (já com app.current_organization_id definido)
  // que o processor usa para ler o evento e, ao final, marcá-lo
  // COMPLETED. Handlers DEVEM reutilizar este tx (nunca abrir uma
  // transação própria) para que seus efeitos colaterais e a
  // conclusão do evento na outbox commitem ou sofram rollback juntos.
  tx: Prisma.TransactionClient;
}

export type NotificationHandler = (
  payload: OutboxEventPayload,
  context: NotificationHandlerContext,
) => Promise<void>;

interface NotificationWorkerConfig {
  queueName: string;
  maxAttempts: number;
  backoffMs: number;
  intervalMs: number;
  batchSize: number;
  staleProcessingMs: number;
}

interface NotificationJobData {
  outboxEventId: string;
  organizationId: string;
  eventType: string;
}

interface ClaimedOutboxEvent {
  id: string;
  eventType: string;
  payload: unknown;
}

const DEFAULT_QUEUE_NAME = "notifications";

/**
 * Consome a outbox (T-5.1.1) via BullMQ.
 *
 * pollOnce() reivindica lotes de eventos PENDING por organização com
 * `UPDATE ... FOR UPDATE SKIP LOCKED` (a mesma disciplina de
 * concorrência real usada em applications_one_approved_per_shift) —
 * dois pollers concorrentes nunca reivindicam a mesma linha. Cada
 * evento reivindicado vira um job BullMQ com jobId = OutboxEvent.id,
 * o que impede duplicar o enfileiramento do mesmo evento.
 *
 * Antes de chamar o handler, o processor confere o status atual no
 * banco: só executa se ainda estiver PROCESSING (reivindicado por
 * esta claim). Um job duplicado/replayado para um evento já
 * COMPLETED vira no-op — a idempotência não depende do handler ser
 * bem-comportado.
 *
 * Falha esgotada (attemptsMade atinge o limite configurado) move o
 * evento para DEAD_LETTER com o erro gravado — consultável via
 * OutboxService.listDeadLetter.
 */
@Injectable()
export class NotificationWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationWorkerService.name);
  // Múltiplos handlers por eventType: um mesmo evento (ex.:
  // application.decided) pode disparar mais de um efeito colateral
  // (notificação in-app E email). Cada handler precisa ser
  // idempotente-seguro por conta própria, pois se QUALQUER handler
  // falhar, o job inteiro é reprocessado -- reexecutando também os
  // handlers que já tinham tido sucesso na tentativa anterior.
  private readonly handlers = new Map<string, NotificationHandler[]>();

  private config: NotificationWorkerConfig = {
    queueName: DEFAULT_QUEUE_NAME,
    maxAttempts: Number(process.env.NOTIFICATIONS_MAX_ATTEMPTS ?? 5),
    backoffMs: Number(process.env.NOTIFICATIONS_BACKOFF_MS ?? 2000),
    intervalMs: Number(process.env.NOTIFICATIONS_POLL_INTERVAL_MS ?? 1000),
    batchSize: 20,
    // Uma linha presa em PROCESSING (worker morreu entre claimBatch
    // commitar e o job correspondente ser enfileirado no Redis, ou o
    // Redis foi perdido depois do claim) nunca era reivindicada de
    // volta -- claimBatch só olha PENDING. O runbook já documentava
    // essa lacuna como remediação manual; agora é automática: toda
    // passada de poll primeiro devolve para PENDING qualquer linha
    // PROCESSING mais velha que este limiar. Seguro porque cada
    // handler já é idempotente por desenho (T-5.1.3/T-5.1.4). Bug
    // real encontrado em auditoria.
    staleProcessingMs: Number(process.env.NOTIFICATIONS_STALE_PROCESSING_MS ?? 5 * 60 * 1000),
  };

  private queue?: Queue<NotificationJobData>;
  private worker?: Worker<NotificationJobData>;
  private pollTimer?: NodeJS.Timeout;
  private polling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Só pode ser chamado antes de start(). Usado por testes para números pequenos/rápidos e nome de fila isolado. */
  configure(overrides: Partial<NotificationWorkerConfig>): void {
    if (this.worker) {
      throw new Error("NotificationWorkerService já iniciado — configure() deve ser chamado antes de start()");
    }
    this.config = { ...this.config, ...overrides };
  }

  registerHandler(eventType: string, handler: NotificationHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.NOTIFICATIONS_WORKER_ENABLED === "true") {
      await this.start();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.worker) return;
    const redisUrl = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
    // Conexões passadas como opções (não como instância ioredis já
    // aberta) para que Queue/Worker criem e fechem sua própria
    // conexão internamente em stop() — evita conflito de versão do
    // ioredis entre a dependência direta e a interna do BullMQ.
    // maxRetriesPerRequest: null é exigido pelo BullMQ para os
    // comandos bloqueantes de polling da fila.
    const connection: ConnectionOptions = {
      host: redisUrl.hostname,
      port: Number(redisUrl.port || 6379),
      password: redisUrl.password || undefined,
      maxRetriesPerRequest: null,
    };

    this.queue = new Queue<NotificationJobData>(this.config.queueName, { connection });
    this.worker = new Worker<NotificationJobData>(
      this.config.queueName,
      (job) => this.processJob(job),
      { connection, concurrency: 5 },
    );
    this.worker.on("failed", (job, err) => {
      void this.handleFailure(job, err).catch((cause) =>
        this.logger.error(`Falha ao registrar dead-letter do job ${job?.id}: ${cause}`),
      );
    });

    if (this.config.intervalMs > 0) {
      this.pollTimer = setInterval(() => {
        void this.pollOnce().catch((err) => this.logger.error(`Poll da outbox falhou: ${err}`));
      }, this.config.intervalMs);
      this.pollTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    await this.worker?.close();
    await this.queue?.close();
    this.worker = undefined;
    this.queue = undefined;
  }

  /**
   * Uma passada de claim + enfileiramento. Retorna quantos eventos
   * foram reivindicados. Por padrão varre todas as organizações
   * (comportamento real do worker, que não pertence a um tenant).
   * organizationIds permite restringir a varredura — usado por
   * testes para não reivindicar eventos de outras suítes rodando
   * concorrentemente contra o mesmo Postgres de desenvolvimento.
   */
  async pollOnce(organizationIds?: string[]): Promise<number> {
    if (!this.queue) {
      throw new Error("NotificationWorkerService não iniciado — chame start() antes de pollOnce()");
    }
    if (this.polling) return 0;
    this.polling = true;
    try {
      const organizations = organizationIds
        ? organizationIds.map((id) => ({ id }))
        : await this.prisma.organization.findMany({ select: { id: true } });
      let claimedTotal = 0;
      for (const { id: organizationId } of organizations) {
        const reclaimed = await this.reclaimStaleProcessing(organizationId);
        if (reclaimed > 0) {
          this.logger.warn(
            `Reivindicou ${reclaimed} evento(s) presos em PROCESSING (organização ${organizationId})`,
          );
        }
        const claimed = await this.claimBatch(organizationId);
        for (const event of claimed) {
          await this.queue.add(
            event.eventType,
            { outboxEventId: event.id, organizationId, eventType: event.eventType },
            {
              jobId: event.id,
              attempts: this.config.maxAttempts,
              backoff: { type: "exponential", delay: this.config.backoffMs },
              removeOnComplete: true,
              removeOnFail: false,
            },
          );
        }
        claimedTotal += claimed.length;
      }
      return claimedTotal;
    } finally {
      this.polling = false;
    }
  }

  /**
   * Devolve para PENDING qualquer linha PROCESSING mais velha que
   * staleProcessingMs — reclaim automático da lacuna de durabilidade
   * documentada em docs/operations/runbooks.md (worker morto entre o
   * claim e o enqueue no Redis). Usa a mesma trava FOR UPDATE SKIP
   * LOCKED de claimBatch para nunca disputar linha com outro worker
   * fazendo a mesma varredura concorrentemente.
   */
  private async reclaimStaleProcessing(organizationId: string): Promise<number> {
    const staleSeconds = Math.floor(this.config.staleProcessingMs / 1000);
    const reclaimed = await this.tenantContext.withTenantScope(organizationId, (tx) =>
      tx.$queryRaw<{ id: string }[]>`
        UPDATE outbox_events
        SET status = 'PENDING', available_at = (now() AT TIME ZONE 'UTC')
        WHERE id IN (
          SELECT id FROM outbox_events
          WHERE organization_id = ${organizationId}
            AND status = 'PROCESSING'
            AND updated_at < (now() AT TIME ZONE 'UTC') - (${staleSeconds} * interval '1 second')
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id
      `,
    );
    return reclaimed.length;
  }

  private async claimBatch(organizationId: string): Promise<ClaimedOutboxEvent[]> {
    return this.tenantContext.withTenantScope(organizationId, (tx) =>
      tx.$queryRaw<ClaimedOutboxEvent[]>`
        UPDATE outbox_events
        SET status = 'PROCESSING'
        WHERE id IN (
          SELECT id FROM outbox_events
          WHERE organization_id = ${organizationId}
            AND status = 'PENDING'
            -- available_at é "timestamp" sem timezone, mas armazena o
            -- relógio de parede em UTC (convenção do Prisma Client
            -- para DateTime nesta base -- ver startsAt/endsAt em
            -- Shift). now() é timestamptz; comparar direto contra ele
            -- (ou contra um parâmetro Date vinculado cru) fica sujeito
            -- ao timezone da sessão do Postgres, produzindo resultado
            -- errado quando a sessão não está em UTC. AT TIME ZONE
            -- 'UTC' converte now() para o mesmo "timestamp naive em
            -- UTC" antes de comparar.
            AND available_at <= (now() AT TIME ZONE 'UTC')
          ORDER BY created_at ASC
          LIMIT ${this.config.batchSize}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, event_type AS "eventType", payload
      `,
    );
  }

  private async processJob(job: Job<NotificationJobData>): Promise<void> {
    const { outboxEventId, organizationId, eventType } = job.data;
    // Extrai o trace context gravado por OutboxService.enqueue (T-5.2.2)
    // -- o span de entrega abre como filho da MESMA trace da
    // requisição HTTP que originou o evento, mesmo processando muito
    // depois, num job sem relação de call-stack direta com ela. Isso
    // é o que torna correlationId (traceId) ponta a ponta real.
    const preRead = await this.tenantContext.withTenantScope(organizationId, (tx) =>
      tx.outboxEvent.findUnique({ where: { id: outboxEventId }, select: { payload: true } }),
    );
    const parentContext = extractTraceContext((preRead?.payload as unknown as StoredEventPayload | undefined)?._trace);

    await withSpan(
      "notification.deliver",
      { "notification.event_type": eventType, "notification.organization_id": organizationId },
      async () => {
        await this.tenantContext.withTenantScope(organizationId, async (tx) => {
          const event = await tx.outboxEvent.findUnique({ where: { id: outboxEventId } });
          if (!event || event.status !== "PROCESSING") {
            // Já concluído (ou não mais reivindicado) por outra execução -- no-op idempotente.
            return;
          }
          const eventHandlers = this.handlers.get(eventType);
          if (!eventHandlers || eventHandlers.length === 0) {
            telemetry.notificationDeliveryCounter.add(1, { "notification.event_type": eventType, "notification.result": "no_handler" });
            throw new Error(`Nenhum handler registrado para eventType "${eventType}"`);
          }
          const payload = event.payload as unknown as OutboxEventPayload;
          for (const handler of eventHandlers) {
            await handler(payload, { organizationId, outboxEventId, tx });
          }
          await tx.outboxEvent.update({
            where: { id: outboxEventId },
            data: { status: "COMPLETED", attempts: job.attemptsMade },
          });
          telemetry.notificationDeliveryCounter.add(1, { "notification.event_type": eventType, "notification.result": "delivered" });
          logEvent("notification.deliver", { organizationId, eventType, outboxEventId });
        });
      },
      parentContext,
    );
  }

  private async handleFailure(job: Job<NotificationJobData> | undefined, err: Error): Promise<void> {
    if (!job) return;
    const { outboxEventId, organizationId } = job.data;
    const attemptsMax = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade >= attemptsMax;

    await this.tenantContext.withTenantScope(organizationId, (tx) =>
      tx.outboxEvent.updateMany({
        where: { id: outboxEventId, status: "PROCESSING" },
        data: isFinalAttempt
          ? { status: "DEAD_LETTER", lastError: err.message, attempts: job.attemptsMade }
          : { lastError: err.message, attempts: job.attemptsMade },
      }),
    );
  }
}
