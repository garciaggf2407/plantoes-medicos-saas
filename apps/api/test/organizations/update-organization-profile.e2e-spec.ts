import { beforeAll, afterAll, describe, expect, it } from "vitest";
import cookieParser from "cookie-parser";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { UserRole } from "@prisma/client";
import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { SessionService, type SessionPayload } from "../../src/identity/session.service";
import { createAdminPrismaForTestCleanup } from "../support/admin-prisma";

process.env.SESSION_SECRET ??= "test-only-session-secret-32-characters";
process.env.OIDC_ISSUER_URL = "";
process.env.COOKIE_SECURE ??= "true";
process.env.DATABASE_URL =
  "postgresql://plantoes_app:plantoes_app_dev_local@localhost:5432/plantoes_medicos?schema=public";

/**
 * Perfil do hospital (BP-2026-07-12-001, T-1.2.3): GET/PATCH
 * /organizations/me. Como a rota nunca aceita um :id (DP-04 --
 * sempre "me", resolvido via sessão), o teste de isolamento cross-
 * tenant verifica que dois hospital_admin distintos, cada um chamando
 * "/me", só enxergam e só alteram o PRÓPRIO hospital -- nunca o do
 * outro, mesmo tendo os dois ids disponíveis no teste.
 */
describe("Perfil do hospital (integração — GET/PATCH /organizations/me)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;

  let orgA: { id: string };
  let orgB: { id: string };

  const adminA = { subject: `admin-a-${randomUUID()}`, email: `admin-a-${randomUUID()}@example.com` };
  const adminB = { subject: `admin-b-${randomUUID()}`, email: `admin-b-${randomUUID()}@example.com` };
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

    orgA = await prisma.organization.create({
      data: { name: `Hospital A ${randomUUID()}`, timezone: "America/Sao_Paulo", city: "Origem A" },
    });
    orgB = await prisma.organization.create({
      data: { name: `Hospital B ${randomUUID()}`, timezone: "America/Sao_Paulo", city: "Origem B" },
    });

    await prisma.user.create({
      data: { oidcSubject: adminA.subject, email: adminA.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgA.id },
    });
    await prisma.user.create({
      data: { oidcSubject: adminB.subject, email: adminB.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgB.id },
    });
    await prisma.user.create({
      data: { oidcSubject: doctor.subject, email: doctor.email, role: UserRole.DOCTOR, organizationId: null },
    });
  });

  afterAll(async () => {
    const admin = createAdminPrismaForTestCleanup();
    await admin.auditLog.deleteMany({ where: { organizationId: { in: [orgA.id, orgB.id] } } });
    await admin.$disconnect();
    await prisma.user.deleteMany({ where: { oidcSubject: { in: [adminA.subject, adminB.subject, doctor.subject] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await app.close();
  });

  it("hospital_admin edita city/address/description/photoUrl e GET reflete a mudança", async () => {
    const patchRes = await request(app.getHttpServer())
      .patch("/organizations/me")
      .set("Cookie", cookieFor(adminA.subject))
      .send({ city: "São Paulo", address: "Av. Paulista, 1000", description: "Hospital geral", photoUrl: "https://example.com/foto.png" });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body).toMatchObject({
      city: "São Paulo",
      address: "Av. Paulista, 1000",
      description: "Hospital geral",
      photoUrl: "https://example.com/foto.png",
    });

    const getRes = await request(app.getHttpServer()).get("/organizations/me").set("Cookie", cookieFor(adminA.subject));
    expect(getRes.status).toBe(200);
    expect(getRes.body).toMatchObject({
      city: "São Paulo",
      address: "Av. Paulista, 1000",
      description: "Hospital geral",
      photoUrl: "https://example.com/foto.png",
    });
  });

  it("update parcial não apaga campos não enviados", async () => {
    await request(app.getHttpServer())
      .patch("/organizations/me")
      .set("Cookie", cookieFor(adminA.subject))
      .send({ city: "Campinas" })
      .expect(200);

    const getRes = await request(app.getHttpServer()).get("/organizations/me").set("Cookie", cookieFor(adminA.subject));
    expect(getRes.body.city).toBe("Campinas");
    // address/description/photoUrl setados no teste anterior continuam intactos.
    expect(getRes.body.address).toBe("Av. Paulista, 1000");
    expect(getRes.body.description).toBe("Hospital geral");
    expect(getRes.body.photoUrl).toBe("https://example.com/foto.png");
  });

  it("hospital_admin de ORG-B não consegue ler nem editar o perfil de ORG-A (isolamento) mesmo sabendo o id", async () => {
    const getRes = await request(app.getHttpServer()).get("/organizations/me").set("Cookie", cookieFor(adminB.subject));
    expect(getRes.status).toBe(200);
    expect(getRes.body.city).toBe("Origem B"); // nunca "Campinas" (dado de org-A)

    const patchRes = await request(app.getHttpServer())
      .patch("/organizations/me")
      .set("Cookie", cookieFor(adminB.subject))
      .send({ city: "Cidade de B" });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.city).toBe("Cidade de B");

    const orgAStillIntact = await prisma.organization.findUniqueOrThrow({ where: { id: orgA.id } });
    expect(orgAStillIntact.city).toBe("Campinas"); // org-A não foi tocado pelo PATCH de admin-B
    const orgBUpdated = await prisma.organization.findUniqueOrThrow({ where: { id: orgB.id } });
    expect(orgBUpdated.city).toBe("Cidade de B");
  });

  it("photoUrl inválida é rejeitada com 400", async () => {
    const res = await request(app.getHttpServer())
      .patch("/organizations/me")
      .set("Cookie", cookieFor(adminA.subject))
      .send({ photoUrl: "não é url" });
    expect(res.status).toBe(400);
  });

  it("DOCTOR autenticado recebe 403 em GET e PATCH /organizations/me", async () => {
    const getRes = await request(app.getHttpServer()).get("/organizations/me").set("Cookie", cookieFor(doctor.subject));
    expect(getRes.status).toBe(403);

    const patchRes = await request(app.getHttpServer())
      .patch("/organizations/me")
      .set("Cookie", cookieFor(doctor.subject))
      .send({ city: "Não deveria funcionar" });
    expect(patchRes.status).toBe(403);
  });
});
