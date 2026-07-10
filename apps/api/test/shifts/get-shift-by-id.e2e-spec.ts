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

describe("GET /shifts/:id (integração — detalhe de plantão para candidatura)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;

  const doctor = { subject: `doctor-${randomUUID()}`, email: `doctor-${randomUUID()}@example.com` };
  let orgA: { id: string };
  let orgB: { id: string };
  let adminAUser: { id: string };
  const createdUserIds: string[] = [];
  let publishedShiftId: string;
  let draftShiftId: string;

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

    const users = await Promise.all([
      prisma.user.create({ data: { oidcSubject: doctor.subject, email: doctor.email, role: UserRole.DOCTOR } }),
      prisma.user.create({
        data: { oidcSubject: `admin-a-${randomUUID()}`, email: `admin-a-${randomUUID()}@example.com`, role: UserRole.HOSPITAL_ADMIN, organizationId: orgA.id },
      }),
    ]);
    createdUserIds.push(...users.map((u) => u.id));
    adminAUser = users[1];

    const shifts = await tenantContext.withTenantScope(orgA.id, (tx) =>
      Promise.all([
        tx.shift.create({
          data: {
            organizationId: orgA.id,
            specialty: "Cardiologia",
            valueCents: 50000,
            startsAt: new Date("2026-08-01T08:00:00Z"),
            endsAt: new Date("2026-08-01T16:00:00Z"),
            status: "PUBLISHED",
            createdByUserId: adminAUser.id,
          },
        }),
        tx.shift.create({
          data: {
            organizationId: orgA.id,
            specialty: "Pediatria",
            valueCents: 40000,
            startsAt: new Date("2026-08-02T08:00:00Z"),
            endsAt: new Date("2026-08-02T16:00:00Z"),
            status: "DRAFT",
            createdByUserId: adminAUser.id,
          },
        }),
      ]),
    );
    publishedShiftId = shifts[0].id;
    draftShiftId = shifts[1].id;
  });

  afterAll(async () => {
    for (const orgId of [orgA.id, orgB.id]) {
      await tenantContext.withTenantScope(orgId, (tx) => tx.shift.deleteMany({ where: { organizationId: orgId } }));
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await app.close();
  });

  it("retorna o plantão PUBLISHED para o médico", async () => {
    const res = await request(app.getHttpServer())
      .get(`/shifts/${publishedShiftId}`)
      .query({ organizationId: orgA.id })
      .set("Cookie", cookieFor(doctor.subject));
    expect(res.status).toBe(200);
    expect(res.body.specialty).toBe("Cardiologia");
  });

  it("retorna 404 para plantão DRAFT (nunca visível fora do admin)", async () => {
    const res = await request(app.getHttpServer())
      .get(`/shifts/${draftShiftId}`)
      .query({ organizationId: orgA.id })
      .set("Cookie", cookieFor(doctor.subject));
    expect(res.status).toBe(404);
  });

  it("retorna 404 pedindo o plantão de org-A com organizationId de org-B", async () => {
    const res = await request(app.getHttpServer())
      .get(`/shifts/${publishedShiftId}`)
      .query({ organizationId: orgB.id })
      .set("Cookie", cookieFor(doctor.subject));
    expect(res.status).toBe(404);
  });

  it("exige sessão autenticada", async () => {
    const res = await request(app.getHttpServer()).get(`/shifts/${publishedShiftId}`).query({ organizationId: orgA.id });
    expect(res.status).toBe(401);
  });
});
