import { Injectable, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { TenantContextService } from "../organizations/tenant-context";
import {
  NotificationWorkerService,
  type NotificationHandlerContext,
} from "./notification.worker";
import type { ApplicationDecidedPayload, OutboxEventPayload, ShiftPublishedPayload } from "./outbox.service";

export interface NotificationListItem {
  id: string;
  type: string;
  payload: unknown;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationListResult {
  items: NotificationListItem[];
  page: number;
  pageSize: number;
  total: number;
  unreadCount: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

/**
 * Armazenamento, listagem paginada, contagem de não lidas e
 * marcação de leitura de notificações in-app (T-5.1.3).
 *
 * O payload gravado em cada notificação é deliberadamente mínimo —
 * nunca inclui texto de justificativa nem evidência de credencial
 * (CRM). O destinatário busca detalhes completos (se precisar) pelos
 * endpoints já existentes de plantão/candidatura, sempre sujeitos às
 * mesmas checagens de autorização daqueles endpoints.
 *
 * Também registra os handlers que conectam a outbox (T-5.1.1) via
 * worker (T-5.1.2) a este armazenamento: shift.published notifica
 * todo médico com especialidade compatível E credencial aprovada
 * naquele hospital (fan-out); application.decided notifica só o
 * médico candidato, com a decisão mas sem a justificativa.
 */
@Injectable()
export class InAppService implements OnModuleInit {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly worker: NotificationWorkerService,
  ) {}

  onModuleInit(): void {
    this.worker.registerHandler("shift.published", (payload, ctx) => this.handleShiftPublished(payload, ctx));
    this.worker.registerHandler("application.decided", (payload, ctx) => this.handleApplicationDecided(payload, ctx));
  }

  /**
   * Cria uma notificação in-app dentro do `tx` já aberto pelo
   * chamador (handler do worker, ou qualquer código já dentro de um
   * withTenantScope). sourceOutboxEventId + userId têm constraint
   * única no schema — uma segunda tentativa para o mesmo (evento,
   * destinatário) é tratada como sucesso (idempotente), nunca cria
   * duplicata.
   */
  async create(
    tx: Prisma.TransactionClient,
    params: {
      organizationId: string;
      userId: string;
      type: string;
      payload: Prisma.InputJsonValue;
      sourceOutboxEventId: string;
    },
  ): Promise<void> {
    try {
      await tx.notification.create({
        data: {
          organizationId: params.organizationId,
          userId: params.userId,
          channel: "IN_APP",
          type: params.type,
          payload: params.payload,
          sourceOutboxEventId: params.sourceOutboxEventId,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return;
      }
      throw error;
    }
  }

  async listForUser(userId: string, page = 1, pageSize = DEFAULT_PAGE_SIZE): Promise<NotificationListResult> {
    const safePage = page > 0 ? Math.floor(page) : 1;
    const safePageSize = Math.min(Math.max(1, Math.floor(pageSize)), MAX_PAGE_SIZE);

    return this.tenantContext.withNotificationRecipientScope(userId, async (tx) => {
      const [items, total, unreadCount] = await Promise.all([
        tx.notification.findMany({
          where: { userId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (safePage - 1) * safePageSize,
          take: safePageSize,
          select: { id: true, type: true, payload: true, readAt: true, createdAt: true },
        }),
        tx.notification.count({ where: { userId } }),
        tx.notification.count({ where: { userId, readAt: null } }),
      ]);
      return { items, page: safePage, pageSize: safePageSize, total, unreadCount };
    });
  }

  async countUnread(userId: string): Promise<number> {
    return this.tenantContext.withNotificationRecipientScope(userId, (tx) =>
      tx.notification.count({ where: { userId, readAt: null } }),
    );
  }

  /** Idempotente: marcar como lida uma notificação já lida (ou inexistente/de outro usuário) é um no-op silencioso. */
  async markRead(userId: string, notificationId: string): Promise<void> {
    await this.tenantContext.withNotificationRecipientScope(userId, (tx) =>
      tx.notification.updateMany({
        where: { id: notificationId, userId, readAt: null },
        data: { readAt: new Date() },
      }),
    );
  }

  private async handleShiftPublished(payload: OutboxEventPayload, ctx: NotificationHandlerContext): Promise<void> {
    const { shiftId, specialty } = payload as ShiftPublishedPayload;
    const compatibleDoctors = await ctx.tx.doctorProfile.findMany({
      where: {
        specialties: { has: specialty },
        credentials: { some: { organizationId: ctx.organizationId, status: "APPROVED" } },
      },
      select: { userId: true },
    });
    for (const doctor of compatibleDoctors) {
      await this.create(ctx.tx, {
        organizationId: ctx.organizationId,
        userId: doctor.userId,
        type: "shift.published",
        payload: { shiftId, specialty },
        sourceOutboxEventId: ctx.outboxEventId,
      });
    }
  }

  private async handleApplicationDecided(payload: OutboxEventPayload, ctx: NotificationHandlerContext): Promise<void> {
    const { applicationId, shiftId, doctorProfileId, decision } = payload as ApplicationDecidedPayload;
    const doctorProfile = await ctx.tx.doctorProfile.findUnique({
      where: { id: doctorProfileId },
      select: { userId: true },
    });
    if (!doctorProfile) return;
    await this.create(ctx.tx, {
      organizationId: ctx.organizationId,
      userId: doctorProfile.userId,
      type: "application.decided",
      payload: { applicationId, shiftId, decision },
      sourceOutboxEventId: ctx.outboxEventId,
    });
  }
}
