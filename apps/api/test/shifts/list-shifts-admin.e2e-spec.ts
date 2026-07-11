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

describe("GET /shifts (integração — lista administrativa em qualquer status)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;
  let orgA: { id: string };
  let orgB: { id: string };
  let adminAUserId: string;
  const createdUserIds: string[] = [];
  const adminA = { subject: `admin-a-${randomUUID()}`, email: `admin-a-${randomUUID()}@example.com` };
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
    tenantContext = moduleRef.get(TenantContextService);

    orgA = await prisma.organization.create({ data: { name: `Hospital A ${randomUUID()}`, timezone: "America/Sao_Paulo" } });
    orgB = await prisma.organization.create({ data: { name: `Hospital B ${randomUUID()}`, timezone: "America/Sao_Paulo" } });
    const adminAUser = await prisma.user.create({
      data: { oidcSubject: adminA.subject, email: adminA.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgA.id },
    });
    const doctorUser = await prisma.user.create({ data: { oidcSubject: doctor.subject, email: doctor.email, role: UserRole.DOCTOR } });
    createdUserIds.push(adminAUser.id, doctorUser.id);
    adminAUserId = adminAUser.id;

    await tenantContext.withTenantScope(orgA.id, (tx) =>
      Promise.all([
        tx.shift.create({ data: { organizationId: orgA.id, specialty: "Cardiologia", valueCents: 1000, startsAt: new Date(), endsAt: new Date(Date.now() + 3600000), status: "DRAFT", createdByUserId: adminAUserId } }),
        tx.shift.create({ data: { organizationId: orgA.id, specialty: "Cardiologia", valueCents: 2000, startsAt: new Date(), endsAt: new Date(Date.now() + 3600000), status: "PUBLISHED", createdByUserId: adminAUserId } }),
        tx.shift.create({ data: { organizationId: orgA.id, specialty: "Cardiologia", valueCents: 3000, startsAt: new Date(), endsAt: new Date(Date.now() + 3600000), status: "CANCELLED", createdByUserId: adminAUserId } }),
      ]),
    );
    await tenantContext.withTenantScope(orgB.id, (tx) =>
      tx.shift.create({ data: { organizationId: orgB.id, specialty: "Pediatria", valueCents: 4000, startsAt: new Date(), endsAt: new Date(Date.now() + 3600000), status: "PUBLISHED", createdByUserId: adminAUserId } }),
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

  it("admin vê todos os status do próprio hospital, nunca de outro hospital", async () => {
    const res = await request(app.getHttpServer()).get("/shifts").set("Cookie", cookieFor(adminA.subject));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    const statuses = res.body.map((s: { status: string }) => s.status).sort();
    expect(statuses).toEqual(["CANCELLED", "DRAFT", "PUBLISHED"]);
  });

  it("DOCTOR não consegue usar a rota administrativa (403)", async () => {
    const res = await request(app.getHttpServer()).get("/shifts").set("Cookie", cookieFor(doctor.subject));
    expect(res.status).toBe(403);
  });
});
