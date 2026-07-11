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
process.env.DATABASE_URL ??=
  "postgresql://plantoes_app:plantoes_app_dev_local@localhost:5432/plantoes_medicos?schema=public";

describe("GET /me (integração)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let org: { id: string; name: string };
  const createdUserIds: string[] = [];
  const admin = { subject: `admin-${randomUUID()}`, email: `admin-${randomUUID()}@example.com` };
  const doctor = { subject: `doctor-${randomUUID()}`, email: `doctor-${randomUUID()}@example.com` };

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

    org = await prisma.organization.create({ data: { name: `Hospital Me ${randomUUID()}`, timezone: "America/Sao_Paulo" } });
    const users = await Promise.all([
      prisma.user.create({ data: { oidcSubject: admin.subject, email: admin.email, role: UserRole.HOSPITAL_ADMIN, organizationId: org.id } }),
      prisma.user.create({ data: { oidcSubject: doctor.subject, email: doctor.email, role: UserRole.DOCTOR } }),
    ]);
    createdUserIds.push(...users.map((u) => u.id));
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
    await app.close();
  });

  it("hospital_admin recebe organizationId e organizationName", async () => {
    const res = await request(app.getHttpServer()).get("/me").set("Cookie", cookieFor(admin.subject));
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("HOSPITAL_ADMIN");
    expect(res.body.organizationId).toBe(org.id);
    expect(res.body.organizationName).toBe(org.name);
  });

  it("doctor recebe organizationId/organizationName nulos", async () => {
    const res = await request(app.getHttpServer()).get("/me").set("Cookie", cookieFor(doctor.subject));
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("DOCTOR");
    expect(res.body.organizationId).toBeNull();
    expect(res.body.organizationName).toBeNull();
  });

  it("sem sessão retorna 401", async () => {
    const res = await request(app.getHttpServer()).get("/me");
    expect(res.status).toBe(401);
  });
});
