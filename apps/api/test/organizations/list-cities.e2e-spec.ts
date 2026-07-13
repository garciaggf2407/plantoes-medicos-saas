import { beforeAll, afterAll, describe, expect, it } from "vitest";
import cookieParser from "cookie-parser";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { UserRole } from "@prisma/client";
import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { SessionService, type SessionPayload } from "../../src/identity/session.service";

process.env.SESSION_SECRET ??= "test-only-session-secret-32-characters";
process.env.OIDC_ISSUER_URL = "";
process.env.COOKIE_SECURE ??= "true";
process.env.DATABASE_URL =
  "postgresql://plantoes_app:plantoes_app_dev_local@localhost:5432/plantoes_medicos?schema=public";

/**
 * GET /cities (BP-2026-07-13-001, T-3.1.1). Cidade única gerada com
 * randomUUID() em cada execução para permitir asserção exata de
 * organizationCount mesmo com dados piloto (Campinas/Bauru) já
 * presentes no banco de dev.
 */
describe("GET /cities (integração — cidades com hospital cadastrado)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;

  const cityWithTwoHospitals = `Cidade Teste ${randomUUID()}`;
  const doctor = { subject: `doctor-${randomUUID()}`, email: `doctor-${randomUUID()}@example.com` };
  const hospitalAdmin = { subject: `admin-${randomUUID()}`, email: `admin-${randomUUID()}@example.com` };
  const superadmin = { subject: `super-${randomUUID()}`, email: `super-${randomUUID()}@example.com` };

  let orgWithCityA: { id: string };
  let orgWithCityB: { id: string };
  let orgWithoutCity: { id: string };
  const createdUserIds: string[] = [];

  function cookieFor(subject: string): string {
    const payload: SessionPayload = { subject, email: "irrelevant@example.com", exp: Math.floor(Date.now() / 1000) + 3600 };
    let captured = "";
    const fakeRes = { cookie: (name: string, value: string) => (captured = `${name}=${value}`) } as unknown as Response;
    sessions.issue(fakeRes, payload);
    return captured;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    sessions = moduleRef.get(SessionService);

    orgWithCityA = await prisma.organization.create({
      data: { name: `Hospital Teste A ${randomUUID()}`, timezone: "America/Sao_Paulo", city: cityWithTwoHospitals },
    });
    orgWithCityB = await prisma.organization.create({
      data: { name: `Hospital Teste B ${randomUUID()}`, timezone: "America/Sao_Paulo", city: cityWithTwoHospitals },
    });
    orgWithoutCity = await prisma.organization.create({
      data: { name: `Hospital Sem Cidade ${randomUUID()}`, timezone: "America/Sao_Paulo" },
    });

    const users = await Promise.all([
      prisma.user.create({ data: { oidcSubject: doctor.subject, email: doctor.email, role: UserRole.DOCTOR } }),
      prisma.user.create({
        data: { oidcSubject: hospitalAdmin.subject, email: hospitalAdmin.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgWithCityA.id },
      }),
      prisma.user.create({ data: { oidcSubject: superadmin.subject, email: superadmin.email, role: UserRole.SUPERADMIN } }),
    ]);
    createdUserIds.push(...users.map((u) => u.id));
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgWithCityA.id, orgWithCityB.id, orgWithoutCity.id] } } });
    await app.close();
  });

  it("retorna a cidade com a contagem exata de hospitais cadastrados", async () => {
    const res = await request(app.getHttpServer()).get("/cities").set("Cookie", cookieFor(doctor.subject));
    expect(res.status).toBe(200);

    const entry = res.body.find((c: { city: string }) => c.city === cityWithTwoHospitals);
    expect(entry).toBeDefined();
    expect(entry.organizationCount).toBe(2);
  });

  it("hospital sem city cadastrada não aparece na lista nem quebra a query", async () => {
    const res = await request(app.getHttpServer()).get("/cities").set("Cookie", cookieFor(doctor.subject));
    expect(res.status).toBe(200);
    expect(res.body.some((c: { city: string | null }) => c.city === null)).toBe(false);
  });

  it("acessível a DOCTOR, HOSPITAL_ADMIN e SUPERADMIN autenticados", async () => {
    const doctorRes = await request(app.getHttpServer()).get("/cities").set("Cookie", cookieFor(doctor.subject));
    const adminRes = await request(app.getHttpServer()).get("/cities").set("Cookie", cookieFor(hospitalAdmin.subject));
    const superadminRes = await request(app.getHttpServer()).get("/cities").set("Cookie", cookieFor(superadmin.subject));

    expect(doctorRes.status).toBe(200);
    expect(adminRes.status).toBe(200);
    expect(superadminRes.status).toBe(200);
  });

  it("sem sessão recebe 401", async () => {
    const res = await request(app.getHttpServer()).get("/cities");
    expect(res.status).toBe(401);
  });
});
