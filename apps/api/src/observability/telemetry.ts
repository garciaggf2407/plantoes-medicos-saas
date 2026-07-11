import { trace, metrics, propagation, context, SpanStatusCode, type Context, type Span, type Counter } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { NodeTracerProvider, BatchSpanProcessor, ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { MeterProvider, PeriodicExportingMetricReader, ConsoleMetricExporter } from "@opentelemetry/sdk-metrics";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";

const SERVICE_NAME = "plantoes-api";

/**
 * Observabilidade dos 5 fluxos críticos (T-5.2.2): login, busca de
 * plantão, candidatura, decisão (credencial/candidatura) e entrega
 * de notificação.
 *
 * Sem endpoint OTLP real configurado neste ambiente (nenhuma conta
 * de backend de observabilidade disponível — mesmo guardrail do
 * blueprint aplicado a OIDC/email: usar doubles até CP-5).
 * OTEL_EXPORTER_OTLP_ENDPOINT ausente/vazio → exporta para o console
 * como JSON estruturado (double real, spans/métricas de verdade,
 * só não saem pela rede); se configurado, usa OTLP HTTP de verdade
 * sem mudar nenhum chamador (mesmo padrão de EmailProvider).
 */
export interface InitTelemetryOptions {
  /** Override de exporter para testes (ex.: InMemorySpanExporter) — nunca usado em runtime normal. */
  traceExporter?: SpanExporter;
  metricExporter?: PushMetricExporter;
  /** Testes chamam initTelemetry() por conta própria (main.ts não roda) — exportação periódica de métrica atrapalha asserts síncronos; default 15s em prod, mas testes devem passar algo bem menor ou forçar flush manual. */
  metricExportIntervalMillis?: number;
}

let activeMeterProvider: MeterProvider | undefined;

/** Só para testes: força a exportação imediata das métricas acumuladas, sem esperar o intervalo periódico. */
export async function flushMetrics(): Promise<void> {
  await activeMeterProvider?.forceFlush();
}

export function initTelemetry(options: InitTelemetryOptions = {}): void {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const resource = resourceFromAttributes({
    "service.name": SERVICE_NAME,
    "service.version": process.env.npm_package_version ?? "0.0.0",
  });

  const traceExporter = options.traceExporter ?? (otlpEndpoint ? new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }) : new ConsoleSpanExporter());
  const tracerProvider = new NodeTracerProvider({
    resource,
    // SimpleSpanProcessor exporta cada span assim que termina (sem
    // buffer) — spans ficam disponíveis pro teste/console
    // imediatamente. BatchSpanProcessor só compensa com um backend
    // OTLP real de verdade, sob volume de produção.
    spanProcessors: [options.traceExporter ? new SimpleSpanProcessor(traceExporter) : otlpEndpoint ? new BatchSpanProcessor(traceExporter) : new SimpleSpanProcessor(traceExporter)],
  });
  // AsyncLocalStorageContextManager: o contexto de trace ativo
  // precisa atravessar fronteiras assíncronas (await de query Prisma,
  // callback de $transaction) para que spans filhos abertos DENTRO
  // de um use case herdem o traceId do span pai automaticamente.
  tracerProvider.register({ contextManager: new AsyncLocalStorageContextManager() });

  const metricExporter = options.metricExporter ?? (otlpEndpoint ? new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics` }) : new ConsoleMetricExporter());
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: options.metricExportIntervalMillis ?? 15_000,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);
  activeMeterProvider = meterProvider;

  // W3C Trace Context: usado para propagar o traceId da requisição
  // HTTP original através da outbox (T-5.1.1) até o worker (T-5.1.2)
  // processar a entrega da notificação, potencialmente segundos ou
  // minutos depois, num job assíncrono sem relação de call-stack
  // direta com a requisição que o originou. Ver
  // injectTraceContext/extractTraceContext abaixo, usados por
  // OutboxService.enqueue e NotificationWorkerService.processJob.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
}

// trace.getTracer() é seguro de chamar no top-level do módulo: a API
// de trace usa um ProxyTracerProvider interno que aceita um delegate
// real DEPOIS (quando initTelemetry() chama tracerProvider.register()),
// então spans abertos por este `tracer` funcionam corretamente mesmo
// que este módulo tenha sido importado antes de initTelemetry() rodar.
//
// metrics.getMeter() NÃO tem esse mecanismo de proxy/delegate na API
// do OpenTelemetry (verificado em @opentelemetry/api 1.9.1) — chamar
// createCounter() cedo demais vincularia os counters PERMANENTEMENTE
// a um MeterProvider no-op, e eles nunca registrariam nada de
// verdade, mesmo depois de initTelemetry() rodar. Por isso os
// counters abaixo são criados sob demanda (getCounters()), no
// primeiro uso real (dentro de um fluxo, bem depois do bootstrap já
// ter chamado initTelemetry()) — nunca no import do módulo.
const tracer = trace.getTracer(SERVICE_NAME);

interface Counters {
  loginCounter: Counter;
  shiftSearchCounter: Counter;
  applicationCounter: Counter;
  decisionCounter: Counter;
  notificationDeliveryCounter: Counter;
}

let counters: Counters | undefined;

function getCounters(): Counters {
  if (!counters) {
    const meter = metrics.getMeter(SERVICE_NAME);
    counters = {
      loginCounter: meter.createCounter("plantoes.login.count", { description: "Logins concluídos com sucesso" }),
      shiftSearchCounter: meter.createCounter("plantoes.shift_search.count", { description: "Buscas de plantão executadas" }),
      applicationCounter: meter.createCounter("plantoes.application.count", { description: "Candidaturas criadas" }),
      decisionCounter: meter.createCounter("plantoes.decision.count", { description: "Decisões administrativas (credencial ou candidatura)" }),
      notificationDeliveryCounter: meter.createCounter("plantoes.notification_delivery.count", {
        description: "Entregas de notificação processadas pelo worker (in-app ou email, sucesso ou falha)",
      }),
    };
  }
  return counters;
}

/** Reinicia o cache de counters — só para testes trocarem de MeterProvider entre execuções isoladas. */
export function resetCountersForTest(): void {
  counters = undefined;
}

export const telemetry = {
  tracer,
  get loginCounter() {
    return getCounters().loginCounter;
  },
  get shiftSearchCounter() {
    return getCounters().shiftSearchCounter;
  },
  get applicationCounter() {
    return getCounters().applicationCounter;
  },
  get decisionCounter() {
    return getCounters().decisionCounter;
  },
  get notificationDeliveryCounter() {
    return getCounters().notificationDeliveryCounter;
  },
};

export interface TraceCarrier {
  traceparent?: string;
  tracestate?: string;
}

/** Serializa o trace context ATIVO para gravar junto de um OutboxEvent — ver OutboxService.enqueue. */
export function injectTraceContext(): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier as unknown as Record<string, string>);
  return carrier;
}

/** Reconstrói o Context remoto a partir do carrier gravado no OutboxEvent — ver NotificationWorkerService.processJob. */
export function extractTraceContext(carrier: TraceCarrier | undefined): Context {
  if (!carrier?.traceparent) {
    return context.active();
  }
  return propagation.extract(context.active(), carrier as unknown as Record<string, string>);
}

/**
 * Executa `fn` dentro de um span ativo (erros são registrados no
 * span e status marcado ERROR antes de propagar — nunca engolidos).
 * Usado nos 5 fluxos críticos (T-5.2.2) para manter o call-site
 * enxuto e consistente.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
  parentContext?: Context,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, parentContext ?? context.active(), async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}
