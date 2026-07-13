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
import { TenantContextService } from "../../src/organizations/tenant-context";
import { SessionService, type SessionPayload } from "../../src/identity/session.service";

process.env.SESSION_SECRET ??= "test-only-session-secret-32-characters";
process.env.OIDC_ISSUER_URL = "";
process.env.COOKIE_SECURE ??= "true";
process.env.DATABASE_URL =
  "postgresql://plantoes_app:plantoes_app_dev_local@localhost:5432/plantoes_medicos?schema=public";

/**
 * GET /shifts/search com city (BP-2026-07-13-001, T-3.1.3). Cidades
 * geradas com randomUUID() por execução para nunca colidir com dados
 * piloto (Campinas/Bauru) já presentes no banco de dev.
 */
describe("GET /shifts/search por cidade (integração — agregação multi-hospital)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;

  const cityX = `Cidade X ${randomUUID()}`;
  const cityY = `Cidade Y ${randomUUID()}`;

  let orgX1: { id: string };
  let orgX2WithoutPublished: { id: string };
  let orgY: { id: string };
  let adminUser: { id: string };

  const doctorWithCityX = { subject: `doctor-cityx-${randomUUID()}`, email: `doctor-cityx-${randomUUID()}@example.com` };
  const doctorNoCity = { subject: `doctor-nocity-${randomUUID()}`, email: `doctor-nocity-${randomUUID()}@example.com` };
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
    tenantContext = moduleRef.get(TenantContextService);

    orgX1 = await prisma.organization.create({ data: { name: `Hospital X1 ${randomUUID()}`, timezone: "America/Sao_Paulo", city: cityX } });
    orgX2WithoutPublished = await prisma.organization.create({ data: { name: `Hospital X2 ${randomUUID()}`, timezone: "America/Sao_Paulo", city: cityX } });
    orgY = await prisma.organization.create({ data: { name: `Hospital Y ${randomUUID()}`, timezone: "America/Sao_Paulo", city: cityY } });

    const adminSubject = `admin-${randomUUID()}`;
    const admin = await prisma.user.create({
      data: { oidcSubject: adminSubject, email: `${adminSubject}@example.com`, role: UserRole.HOSPITAL_ADMIN, organizationId: orgX1.id },
    });
    adminUser = admin;

    const users = await Promise.all([
      prisma.user.create({ data: { oidcSubject: doctorWithCityX.subject, email: doctorWithCityX.email, role: UserRole.DOCTOR } }),
      prisma.user.create({ data: { oidcSubject: doctorNoCity.subject, email: doctorNoCity.email, role: UserRole.DOCTOR } }),
    ]);
    createdUserIds.push(admin.id, ...users.map((u) => u.id));

    await prisma.doctorProfile.create({
      data: { userId: users[0].id, crmNumber: "CRM-CITYX-1", specialties: ["Cardiologia"], city: cityX },
    });
    await prisma.doctorProfile.create({
      data: { userId: users[1].id, crmNumber: "CRM-NOCITY-1", specialties: ["Cardiologia"] },
    });

    const shiftData = (organizationId: string, overrides: Record<string, unknown>) => ({
      organizationId,
      specialty: "Cardiologia",
      valueCents: 50000,
      startsAt: new Date("2026-09-01T08:00:00Z"),
      endsAt: new Date("2026-09-01T16:00:00Z"),
      status: "PUBLISHED" as const,
      createdByUserId: adminUser.id,
      ...overrides,
    });

    // orgX1: 2 PUBLISHED (datas distintas) + 1 DRAFT (nunca deve vazar)
    await tenantContext.withTenantScope(orgX1.id, (tx) =>
      tx.shift.createMany({
        data: [
          shiftData(orgX1.id, { startsAt: new Date("2026-09-01T08:00:00Z") }),
          shiftData(orgX1.id, { startsAt: new Date("2026-09-03T08:00:00Z") }),
          shiftData(orgX1.id, { startsAt: new Date("2026-09-02T08:00:00Z"), status: "DRAFT" }),
        ],
      }),
    );
    // orgX2: 1 PUBLISHED (data intermediária, para provar merge ordenado entre hospitais)
    await tenantContext.withTenantScope(orgX2WithoutPublished.id, (tx) =>
      tx.shift.create({ data: shiftData(orgX2WithoutPublished.id, { startsAt: new Date("2026-09-02T08:00:00Z") }) }),
    );
    // orgY (cidade diferente): nunca deve aparecer em busca por cityX
    await tenantContext.withTenantScope(orgY.id, (tx) =>
      tx.shift.create({ data: shiftData(orgY.id, { startsAt: new Date("2026-09-01T08:00:00Z") }) }),
    );
  });

  afterAll(async () => {
    for (const orgId of [orgX1.id, orgX2WithoutPublished.id, orgY.id]) {
      await tenantContext.withTenantScope(orgId, (tx) => tx.shift.deleteMany({ where: { organizationId: orgId } }));
    }
    await prisma.doctorProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgX1.id, orgX2WithoutPublished.id, orgY.id] } } });
    await app.close();
  });

  it("city explícita agrega PUBLISHED de todos os hospitais da cidade, ordenados por startsAt, nunca DRAFT nem de outra cidade", async () => {
    const res = await request(app.getHttpServer())
      .get("/shifts/search")
      .query({ city: cityX })
      .set("Cookie", cookieFor(doctorWithCityX.subject));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3); // 2 de orgX1 (PUBLISHED) + 1 de orgX2 -- DRAFT de orgX1 excluído, orgY (cidade Y) excluído

    const starts = res.body.items.map((s: { startsAt: string }) => s.startsAt);
    const sorted = [...starts].sort();
    expect(starts).toEqual(sorted);
  });

  it("sem city e sem organizationId usa a cidade cadastrada no perfil do médico", async () => {
    const res = await request(app.getHttpServer()).get("/shifts/search").set("Cookie", cookieFor(doctorWithCityX.subject));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });

  it("médico cadastrado em outra cidade pode trocar livremente via city, sem restrição", async () => {
    const res = await request(app.getHttpServer())
      .get("/shifts/search")
      .query({ city: cityY })
      .set("Cookie", cookieFor(doctorWithCityX.subject)); // médico É da cityX, mas pede cityY
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it("médico sem cidade cadastrada e sem parâmetro nenhum recebe 400 (sem fallback silencioso)", async () => {
    const res = await request(app.getHttpServer()).get("/shifts/search").set("Cookie", cookieFor(doctorNoCity.subject));
    expect(res.status).toBe(400);
  });

  it("organizationId explícito continua funcionando exatamente como antes (retrocompatibilidade)", async () => {
    const res = await request(app.getHttpServer())
      .get("/shifts/search")
      .query({ organizationId: orgX1.id })
      .set("Cookie", cookieFor(doctorWithCityX.subject));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2); // só PUBLISHED de orgX1 (DRAFT excluído, orgX2 não entra pois é organizationId único)
  });

  it("paginação em memória funciona com hospital sem nenhum plantão publicado na cidade (não quebra)", async () => {
    const res = await request(app.getHttpServer())
      .get("/shifts/search")
      .query({ city: cityX, page: 1, pageSize: 2 })
      .set("Cookie", cookieFor(doctorWithCityX.subject));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(3);

    const page2 = await request(app.getHttpServer())
      .get("/shifts/search")
      .query({ city: cityX, page: 2, pageSize: 2 })
      .set("Cookie", cookieFor(doctorWithCityX.subject));
    expect(page2.body.items).toHaveLength(1);

    const allIds = [...res.body.items, ...page2.body.items].map((s: { id: string }) => s.id);
    expect(new Set(allIds).size).toBe(3); // sem sobreposição nem repetição entre páginas
  });

  it("cidade sem nenhum hospital cadastrado retorna lista vazia, não erro", async () => {
    const res = await request(app.getHttpServer())
      .get("/shifts/search")
      .query({ city: `Cidade Sem Hospital ${randomUUID()}` })
      .set("Cookie", cookieFor(doctorWithCityX.subject));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});
