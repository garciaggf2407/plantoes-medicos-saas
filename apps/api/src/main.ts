import "dotenv/config";
import "reflect-metadata";
import cookieParser from "cookie-parser";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
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
