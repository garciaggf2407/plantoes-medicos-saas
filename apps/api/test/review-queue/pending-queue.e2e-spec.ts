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

describe("Fila de revisão (GET /credentials/pending, GET /applications/pending)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;
  let orgA: { id: string };
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
    const adminAUser = await prisma.user.create({
      data: { oidcSubject: adminA.subject, email: adminA.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgA.id },
    });
    const doctorUser = await prisma.user.create({ data: { oidcSubject: doctor.subject, email: doctor.email, role: UserRole.DOCTOR } });
    createdUserIds.push(adminAUser.id, doctorUser.id);
    adminAUserId = adminAUser.id;

    const profile = await prisma.doctorProfile.create({ data: { userId: doctorUser.id, crmNumber: "CRM-QUEUE-1", specialties: ["Cardiologia"] } });

    await tenantContext.withTenantScope(orgA.id, async (tx) => {
      await tx.credential.create({ data: { doctorProfileId: profile.id, organizationId: orgA.id, evidenceUrl: "https://files.example.com/x.pdf", status: "PENDING" } });
      const shift = await tx.shift.create({ data: { organizationId: orgA.id, specialty: "Cardiologia", valueCents: 1000, startsAt: new Date(), endsAt: new Date(Date.now() + 3600000), status: "PUBLISHED", createdByUserId: adminAUserId } });
      await tx.application.create({ data: { shiftId: shift.id, doctorProfileId: profile.id, organizationId: orgA.id, status: "PENDING" } });
    });
  });

  afterAll(async () => {
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.application.deleteMany({ where: { organizationId: orgA.id } }));
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.credential.deleteMany({ where: { organizationId: orgA.id } }));
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.shift.deleteMany({ where: { organizationId: orgA.id } }));
    await prisma.doctorProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: orgA.id } });
    await app.close();
  });

  it("GET /credentials/pending retorna a credencial PENDING sem evidenceUrl (minimização de PII)", async () => {
    const res = await request(app.getHttpServer()).get("/credentials/pending").set("Cookie", cookieFor(adminA.subject));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].doctorProfile.crmNumber).toBe("CRM-QUEUE-1");
    expect(res.body[0].evidenceUrl).toBeUndefined();
  });

  it("GET /applications/pending retorna a candidatura PENDING", async () => {
    const res = await request(app.getHttpServer()).get("/applications/pending").set("Cookie", cookieFor(adminA.subject));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].shift.specialty).toBe("Cardiologia");
    expect(res.body[0].doctorProfile.crmNumber).toBe("CRM-QUEUE-1");
  });

  it("DOCTOR não acessa nenhuma das duas filas (403)", async () => {
    const res1 = await request(app.getHttpServer()).get("/credentials/pending").set("Cookie", cookieFor(doctor.subject));
    const res2 = await request(app.getHttpServer()).get("/applications/pending").set("Cookie", cookieFor(doctor.subject));
    expect(res1.status).toBe(403);
    expect(res2.status).toBe(403);
  });
});
