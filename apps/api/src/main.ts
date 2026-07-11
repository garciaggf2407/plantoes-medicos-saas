import "dotenv/config";
import "reflect-metadata";
import cookieParser from "cookie-parser";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { initTelemetry } from "./observability/telemetry";

async function bootstrap(): Promise<void> {
  // Registra os providers globais de trace/métrica (T-5.2.2) antes
  // de qualquer código do app poder chamar trace.getTracer()/
  // metrics.getMeter() — spans são manuais nos 5 fluxos críticos
  // (sem auto-instrumentação de módulo), então não há necessidade de
  // rodar isso antes dos imports acima.
  initTelemetry();

  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
  // credentials:true exige origin explícita (nunca "*") — o portal
  // web roda em porta diferente da API em desenvolvimento.
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
    credentials: true,
  });
  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  await app.listen(port);
}

void bootstrap();
