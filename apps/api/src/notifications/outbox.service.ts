import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

export type OutboxEventType = "shift.published" | "application.decided";

interface ShiftPublishedPayload {
  version: 1;
  shiftId: string;
  specialty: string;
}

interface ApplicationDecidedPayload {
  version: 1;
  applicationId: string;
  shiftId: string;
  doctorProfileId: string;
  decision: "APPROVED" | "REJECTED";
}

export type OutboxEventPayload = ShiftPublishedPayload | ApplicationDecidedPayload;

/**
 * Outbox transacional. enqueue() SEMPRE recebe o `tx` da MESMA
 * transação Prisma do comando de negócio em andamento (ex.:
 * ShiftCommandsService.publishShift, ReviewApplicationUseCase) —
 * nunca uma conexão separada. Isso garante que o evento só existe
 * se a mudança de negócio também existir, e vice-versa: se qualquer
 * um dos dois falhar, a transação inteira sofre rollback e nenhum
 * evento órfão fica pendente, nem nenhuma mudança de negócio fica
 * sem evento correspondente. Se a transação COMMITA, o evento já
 * está persistido — uma falha do processo logo depois do commit
 * (antes de qualquer notificação real ser enviada) nunca perde o
 * evento: ele permanece PENDING para o worker (T-5.1.2) processar.
 *
 * payload sempre carrega um campo "version" — schema do evento é
 * versionado, para permitir evoluir o formato sem quebrar leitura
 * de eventos antigos ainda não processados pelo worker.
 */
@Injectable()
export class OutboxService {
  async enqueue(
    tx: Prisma.TransactionClient,
    organizationId: string,
    eventType: OutboxEventType,
    payload: OutboxEventPayload,
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        organizationId,
        eventType,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /** Eventos que esgotaram as tentativas do worker (T-5.1.2) — consultável para observabilidade/operação. */
  async listDeadLetter(tx: Prisma.TransactionClient, organizationId: string) {
    return tx.outboxEvent.findMany({
      where: { organizationId, status: "DEAD_LETTER" },
      orderBy: { updatedAt: "desc" },
    });
  }
}
