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

describe("GET /shifts/search (integração — busca paginada por tenant)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;

  const doctor = { subject: `doctor-${randomUUID()}`, email: `doctor-${randomUUID()}@example.com` };
  let orgA: { id: string };
  let orgB: { id: string };
  let adminAUser: { id: string };
  const createdUserIds: string[] = [];

  function cookieFor(subject: string): string {
    const payload: SessionPayload = {
      subject,
      email: "irrelevant@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
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

    orgA = await prisma.organization.create({ data: { name: `Hospital A ${randomUUID()}`, timezone: "America/Sao_Paulo" } });
    orgB = await prisma.organization.create({ data: { name: `Hospital B ${randomUUID()}`, timezone: "America/Sao_Paulo" } });

    const adminA = { subject: `admin-a-${randomUUID()}`, email: `admin-a-${randomUUID()}@example.com` };
    const users = await Promise.all([
      prisma.user.create({ data: { oidcSubject: doctor.subject, email: doctor.email, role: UserRole.DOCTOR } }),
      prisma.user.create({ data: { oidcSubject: adminA.subject, email: adminA.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgA.id } }),
    ]);
    createdUserIds.push(...users.map((u) => u.id));
    adminAUser = users[1];

    const shiftData = (overrides: Record<string, unknown>) => ({
      organizationId: orgA.id,
      specialty: "Cardiologia",
      valueCents: 50000,
      startsAt: new Date("2026-08-01T08:00:00Z"),
      endsAt: new Date("2026-08-01T16:00:00Z"),
      status: "PUBLISHED" as const,
      createdByUserId: adminAUser.id,
      ...overrides,
    });

    await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.shift.createMany({
        data: [
          shiftData({ specialty: "Cardiologia", valueCents: 40000, startsAt: new Date("2026-08-01T08:00:00Z") }),
          shiftData({ specialty: "Cardiologia", valueCents: 60000, startsAt: new Date("2026-08-02T08:00:00Z") }),
          shiftData({ specialty: "Pediatria", valueCents: 30000, startsAt: new Date("2026-08-03T08:00:00Z") }),
          shiftData({ specialty: "Cardiologia", valueCents: 80000, startsAt: new Date("2026-08-04T08:00:00Z"), status: "DRAFT" }),
          shiftData({ specialty: "Cardiologia", valueCents: 45000, startsAt: new Date("2026-08-05T08:00:00Z"), status: "CANCELLED" }),
        ],
      }),
    );

    await tenantContext.withTenantScope(orgB.id, (tx) =>
      tx.shift.create({
        data: {
          organizationId: orgB.id,
          specialty: "Cardiologia",
          valueCents: 50000,
          startsAt: new Date("2026-08-01T08:00:00Z"),
          endsAt: new Date("2026-08-01T16:00:00Z"),
          status: "PUBLISHED",
          createdByUserId: adminAUser.id,
        },
      }),
    );
  });

  afterAll(async () => {
    for (const orgId of [orgA.id, orgB.id]) {
      await tenantContext.withTenantScope(orgId, (tx) => tx.shift.deleteMany({ where: { organizationId: orgId } }));
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await app.close();
  });

  it("retorna apenas plantões PUBLISHED do hospital informado (nunca DRAFT/CANCELLED nem de outro tenant)", async () => {
    const res = await request(app.getHttpServer())
      .get("/shifts/search")
      .query({ organizationId: orgA.id })
      .set("Cookie", cookieFor(doctor.subject));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3); // 3 PUBLISHED em org-A (2 Cardiologia + 1 Pediatria); DRAFT/CANCELLED excluídos
    expect(res.body.items.every((s: { specialty: string }) => true)).toBe(true);
  });

  it("filtra por especialidade", async () => {
    const res = await request(app.getHttpServer())
      .get("/shifts/search")
      .query({ organizationId: orgA.id, specialty: "Pediatria" })
      .set("Cookie", cookieFor(doctor.subject));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].specialty).toBe("Pediatria");
  });

  it("filtra por faixa de valor (min e max combinados)", async () => {
    const res = await request(app.getHttpServer())
      .get("/shifts/search")
      .query({ organizationId: orgA.id, minValueCents: "45000", maxValueCents: "70000" })
      .set("Cookie", cookieFor(doctor.subject));
    expect(res.status).toBe(200);
    // Só o Cardiologia PUBLISHED de 60000 cai nessa faixa (40000 fica abaixo do min)
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].valueCents).toBe(60000);
  });

  it("combina especialidade + valor + período", async () => {
    const res = await request(app.getHttpServer())
      .get("/shifts/search")
      .query({
        organizationId: orgA.id,
        specialty: "cardiologia", // case-insensitive
        minValueCents: "1",
        maxValueCents: "50000",
        from: "2026-08-01T00:00:00Z",
        to: "2026-08-01T23:59:59Z",
      })
      .set("Cookie", cookieFor(doctor.subject));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].valueCents).toBe(40000);
  });

  it("paginação é determinística (mesma página sempre retorna os mesmos itens, na mesma ordem)", async () => {
    const first = await request(app.getHttpServer())
      .get("/shifts/search")
      .query({ organizationId: orgA.id, page: 1, pageSize: 2 })
      .set("Cookie", cookieFor(doctor.subject));
    const second = await request(app.getHttpServer())
      .get("/shifts/search")
      .query({ organizationId: orgA.id, page: 1, pageSize: 2 })
      .set("Cookie", cookieFor(doctor.subject));

    expect(first.body.items.map((s: { id: string }) => s.id)).toEqual(second.body.items.map((s: { id: string }) => s.id));
    expect(first.body.items).toHaveLength(2);

    const page2 = await request(app.getHttpServer())
      .get("/shifts/search")
      .query({ organizationId: orgA.id, page: 2, pageSize: 2 })
      .set("Cookie", cookieFor(doctor.subject));
    expect(page2.body.items).toHaveLength(1);

    const allIds = [...first.body.items, ...page2.body.items].map((s: { id: string }) => s.id);
    expect(new Set(allIds).size).toBe(3); // sem sobreposição nem repetição entre páginas
  });

  it("nunca retorna plantões de outro hospital mesmo pedindo o mesmo filtro", async () => {
    const res = await request(app.getHttpServer())
      .get("/shifts/search")
      .query({ organizationId: orgB.id })
      .set("Cookie", cookieFor(doctor.subject));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].valueCents).toBe(50000);
  });

  it("rejeita minValueCents > maxValueCents com 400", async () => {
    const res = await request(app.getHttpServer())
      .get("/shifts/search")
      .query({ organizationId: orgA.id, minValueCents: "90000", maxValueCents: "1000" })
      .set("Cookie", cookieFor(doctor.subject));
    expect(res.status).toBe(400);
  });
});
