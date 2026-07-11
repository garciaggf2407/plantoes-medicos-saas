import { trace } from "@opentelemetry/api";

/**
 * Nomes de campo NUNCA logados, mesmo se um chamador passar um por
 * engano — defesa em profundidade além de cada call-site já escolher
 * a dedo o que registra. Cobre email, texto livre de justificativa,
 * evidência de credencial (URL) e segredos.
 */
const SENSITIVE_KEYS = new Set([
  "email",
  "justification",
  "evidenceUrl",
  "crmNumber",
  "password",
  "token",
  "cookie",
  "authorization",
  "sessionSecret",
]);

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

export interface StructuredLogLine {
  timestamp: string;
  event: string;
  correlationId: string | null;
  spanId: string | null;
  retentionDays: number;
  [key: string]: unknown;
}

type LogSink = (line: StructuredLogLine) => void;

let sink: LogSink = (line) => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

/** Só para testes: captura as linhas emitidas sem depender de interceptar process.stdout.write (que o runner de teste já usa para outros fins). */
export function setLogSinkForTest(fn: LogSink): void {
  sink = fn;
}

export function resetLogSinkForTest(): void {
  sink = (line) => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };
}

/**
 * Log estruturado (uma linha JSON por evento) correlacionado com o
 * span ativo do OpenTelemetry (T-5.2.2) — correlationId é o traceId,
 * o mesmo id que aparece nos spans/métricas dos 5 fluxos críticos,
 * permitindo cruzar log ⇄ trace ⇄ métrica pela mesma chave ponta a
 * ponta (inclusive através da fronteira assíncrona da outbox — ver
 * telemetry.ts injectTraceContext/extractTraceContext).
 *
 * Retenção: LOG_RETENTION_DAYS documenta a política pretendida para
 * quando um coletor real for configurado (nenhum está disponível
 * neste ambiente — mesmo guardrail de "doubles até CP-5"); por ora
 * os logs vão para stdout, e a rotação/retenção é responsabilidade
 * da infraestrutura de deploy (ver runbooks, T-5.3.1).
 */
export function logEvent(name: string, fields: LogFields = {}): void {
  const safeFields: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEYS.has(key)) {
      continue;
    }
    safeFields[key] = value;
  }

  const spanContext = trace.getActiveSpan()?.spanContext();
  const line: StructuredLogLine = {
    timestamp: new Date().toISOString(),
    event: name,
    correlationId: spanContext?.traceId ?? null,
    spanId: spanContext?.spanId ?? null,
    retentionDays: Number(process.env.LOG_RETENTION_DAYS ?? 30),
    ...safeFields,
  };
  sink(line);
}
