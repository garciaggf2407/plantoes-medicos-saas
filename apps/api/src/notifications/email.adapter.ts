import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { TenantContextService } from "../organizations/tenant-context";
import type { NotificationHandlerContext } from "./notification.worker";
import { NotificationWorkerService } from "./notification.worker";
import { assertPayloadVersion, type ApplicationDecidedPayload, type OutboxEventPayload, type ShiftPublishedPayload } from "./outbox.service";

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface EmailSendResult {
  delivered: boolean;
  providerMessageId?: string;
}

/**
 * Provider é a única fronteira que muda entre ambientes. Trocar de
 * provedor (ex.: de console para um SMTP/API real) é implementar
 * esta interface e ajustar a seleção em resolveProvider() — nenhum
 * chamador (EmailAdapter.sendOnce, os handlers) muda.
 */
export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/**
 * "Double" para ambientes sem conta de provedor real configurada
 * (todo ambiente local/CI deste projeto até o checkpoint de
 * integração CP-5 — ver intent-spec.yaml / BLUEPRINT.md §guardrails:
 * "ausência de provedor de email não impede código local"). Nunca
 * envia rede de verdade; apenas registra e confirma entrega.
 */
export class ConsoleEmailProvider implements EmailProvider {
  private readonly logger = new Logger(ConsoleEmailProvider.name);

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.logger.log(`[email:console] to=${message.to} subject="${message.subject}"`);
    return { delivered: true, providerMessageId: `console-${Date.now()}-${Math.random().toString(36).slice(2)}` };
  }
}

function resolveProvider(): EmailProvider {
  const providerName = process.env.EMAIL_PROVIDER ?? "console";
  switch (providerName) {
    case "console":
      return new ConsoleEmailProvider();
    default:
      throw new Error(
        `EMAIL_PROVIDER="${providerName}" não reconhecido. Nenhum provedor real está configurado neste ambiente ` +
          `(ver guardrail do blueprint: use adapters/doubles até CP-5). Implemente EmailProvider e registre aqui.`,
      );
  }
}

function shiftPublishedTemplate(specialty: string): { subject: string; body: string } {
  return {
    subject: "Novo plantão disponível",
    body: `Um novo plantão de ${specialty} compatível com seu perfil foi publicado. Acesse a plataforma para ver detalhes e se candidatar.`,
  };
}

function applicationDecidedTemplate(decision: "APPROVED" | "REJECTED"): { subject: string; body: string } {
  return decision === "APPROVED"
    ? { subject: "Sua candidatura foi aprovada", body: "Sua candidatura a um plantão foi aprovada. Acesse a plataforma para ver detalhes." }
    : { subject: "Atualização sobre sua candidatura", body: "Sua candidatura a um plantão não foi aprovada desta vez. Acesse a plataforma para ver detalhes." };
}

/**
 * Adapter de email transacional (T-5.1.4). Registra handlers para os
 * mesmos eventos que InAppService (T-5.1.3) consome — um evento pode
 * disparar mais de um canal.
 *
 * Idempotência ("retry não reenvia email já confirmado como
 * entregue"): uma linha em EmailDelivery só é gravada DEPOIS de
 * EmailProvider.send() retornar delivered:true. Um retry do job
 * reconsulta essa tabela antes de tentar enviar de novo — se já
 * existe linha para (sourceOutboxEventId, userId), é um envio
 * confirmado e o retry vira no-op. Se a tentativa anterior falhou
 * (nenhuma linha foi gravada), o retry tenta enviar de novo
 * legitimamente — isso é o comportamento correto, não um bug.
 *
 * IMPORTANTE: a checagem e a gravação de EmailDelivery usam uma
 * transação PRÓPRIA (via tenantContext.withTenantScope), NUNCA
 * ctx.tx — o tx do processor engloba TODOS os handlers do job (ver
 * NotificationWorkerService.processJob); se um handler IRMÃO falhar
 * depois do envio ter sido confirmado, ctx.tx inteiro sofre
 * rollback, o que apagaria a prova de entrega junto (diferente de
 * InAppService: criar uma notificação in-app não tem efeito externo,
 * então é seguro que o rollback desfaça e o retry recrie; um email
 * já enviado de verdade não pode ser "desenviado" por um rollback de
 * banco, então seu registro de confirmação precisa sobreviver a ele).
 *
 * Opt-out é conferido ANTES de qualquer chamada a
 * EmailProvider.send() — nunca depois.
 */
@Injectable()
export class EmailAdapter implements OnModuleInit {
  private provider: EmailProvider = resolveProvider();

  constructor(
    private readonly worker: NotificationWorkerService,
    private readonly tenantContext: TenantContextService,
  ) {}

  onModuleInit(): void {
    this.worker.registerHandler("shift.published", (payload, ctx) => this.handleShiftPublished(payload, ctx));
    this.worker.registerHandler("application.decided", (payload, ctx) => this.handleApplicationDecided(payload, ctx));
  }

  /** Permite trocar o provider em runtime (testes, ou uma futura tela de operação) sem recriar o adapter. */
  setProvider(provider: EmailProvider): void {
    this.provider = provider;
  }

  private async handleShiftPublished(payload: OutboxEventPayload, ctx: NotificationHandlerContext): Promise<void> {
    assertPayloadVersion(payload, 1, "shift.published");
    const { specialty } = payload as ShiftPublishedPayload;
    const compatibleDoctors = await ctx.tx.doctorProfile.findMany({
      where: {
        specialties: { has: specialty },
        credentials: { some: { organizationId: ctx.organizationId, status: "APPROVED" } },
      },
      select: { userId: true },
    });
    const template = shiftPublishedTemplate(specialty);
    for (const doctor of compatibleDoctors) {
      await this.sendOnce(ctx, doctor.userId, template);
    }
  }

  private async handleApplicationDecided(payload: OutboxEventPayload, ctx: NotificationHandlerContext): Promise<void> {
    assertPayloadVersion(payload, 1, "application.decided");
    const { doctorProfileId, decision } = payload as ApplicationDecidedPayload;
    const doctorProfile = await ctx.tx.doctorProfile.findUnique({ where: { id: doctorProfileId }, select: { userId: true } });
    if (!doctorProfile) return;
    await this.sendOnce(ctx, doctorProfile.userId, applicationDecidedTemplate(decision));
  }

  private async sendOnce(
    ctx: NotificationHandlerContext,
    userId: string,
    template: { subject: string; body: string },
  ): Promise<void> {
    const alreadyDelivered = await this.tenantContext.withTenantScope(ctx.organizationId, (tx) =>
      tx.emailDelivery.findUnique({
        where: { sourceOutboxEventId_userId: { sourceOutboxEventId: ctx.outboxEventId, userId } },
      }),
    );
    if (alreadyDelivered) return;

    const user = await ctx.tx.user.findUnique({ where: { id: userId }, select: { email: true, emailOptOut: true } });
    if (!user || user.emailOptOut) return;

    const result = await this.provider.send({ to: user.email, subject: template.subject, body: template.body });
    if (!result.delivered) {
      throw new Error(`Provider de email não confirmou entrega para userId=${userId}`);
    }

    try {
      await this.tenantContext.withTenantScope(ctx.organizationId, (tx) =>
        tx.emailDelivery.create({
          data: {
            organizationId: ctx.organizationId,
            userId,
            sourceOutboxEventId: ctx.outboxEventId,
            providerMessageId: result.providerMessageId,
          },
        }),
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // Corrida com outra tentativa que já registrou a mesma
        // entrega: o email já foi confirmado por outro caminho,
        // então isso é equivalente a sucesso -- não é um erro real.
        return;
      }
      throw error;
    }
  }
}
