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

describe("GET /calendar (integração — calendário do médico agregado entre hospitais)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;

  const doctorA = { subject: `doctor-a-${randomUUID()}`, email: `doctor-a-${randomUUID()}@example.com` };
  const doctorB = { subject: `doctor-b-${randomUUID()}`, email: `doctor-b-${randomUUID()}@example.com` };
  let orgHospitalA: { id: string };
  let orgHospitalB: { id: string };
  let orgDst: { id: string };
  const createdUserIds: string[] = [];
  let adminUserId: string;
  let doctorAProfileId: string;
  let doctorBProfileId: string;

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

  async function createApprovedApplication(
    organizationId: string,
    doctorProfileId: string,
    shiftData: { specialty: string; valueCents: number; startsAt: Date; endsAt: Date },
  ): Promise<void> {
    await tenantContext.withTenantScope(organizationId, async (tx) => {
      const shift = await tx.shift.create({
        data: { organizationId, status: "PUBLISHED", createdByUserId: adminUserId, ...shiftData },
      });
      await tx.application.create({
        data: {
          shiftId: shift.id,
          doctorProfileId,
          organizationId,
          status: "APPROVED",
          decidedByUserId: adminUserId,
          decidedAt: new Date(),
        },
      });
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    sessions = moduleRef.get(SessionService);
    tenantContext = moduleRef.get(TenantContextService);

    orgHospitalA = await prisma.organization.create({ data: { name: `Hospital A ${randomUUID()}`, timezone: "America/Sao_Paulo" } });
    orgHospitalB = await prisma.organization.create({ data: { name: `Hospital B ${randomUUID()}`, timezone: "America/Sao_Paulo" } });
    orgDst = await prisma.organization.create({ data: { name: `Hospital DST ${randomUUID()}`, timezone: "America/New_York" } });

    const adminUser = await prisma.user.create({
      data: { oidcSubject: `admin-${randomUUID()}`, email: `admin-${randomUUID()}@example.com`, role: UserRole.HOSPITAL_ADMIN, organizationId: orgHospitalA.id },
    });
    adminUserId = adminUser.id;

    const users = await Promise.all([
      prisma.user.create({ data: { oidcSubject: doctorA.subject, email: doctorA.email, role: UserRole.DOCTOR } }),
      prisma.user.create({ data: { oidcSubject: doctorB.subject, email: doctorB.email, role: UserRole.DOCTOR } }),
    ]);
    createdUserIds.push(adminUser.id, ...users.map((u) => u.id));

    const doctorAProfile = await prisma.doctorProfile.create({
      data: { userId: users[0].id, crmNumber: "CRM-CAL-A", specialties: ["Cardiologia"] },
    });
    const doctorBProfile = await prisma.doctorProfile.create({
      data: { userId: users[1].id, crmNumber: "CRM-CAL-B", specialties: ["Cardiologia"] },
    });
    doctorAProfileId = doctorAProfile.id;
    doctorBProfileId = doctorBProfile.id;

    // Doutor A: um plantão aprovado no Hospital A e outro no Hospital B (agregação cross-hospital).
    await createApprovedApplication(orgHospitalA.id, doctorAProfileId, {
      specialty: "Cardiologia",
      valueCents: 50000,
      startsAt: new Date("2026-09-01T08:00:00Z"),
      endsAt: new Date("2026-09-01T16:00:00Z"),
    });
    await createApprovedApplication(orgHospitalB.id, doctorAProfileId, {
      specialty: "Cardiologia",
      valueCents: 45000,
      startsAt: new Date("2026-09-05T08:00:00Z"),
      endsAt: new Date("2026-09-05T16:00:00Z"),
    });

    // Doutor B: plantão aprovado no Hospital A (não deve aparecer no calendário do Doutor A).
    await createApprovedApplication(orgHospitalA.id, doctorBProfileId, {
      specialty: "Cardiologia",
      valueCents: 42000,
      startsAt: new Date("2026-09-02T08:00:00Z"),
      endsAt: new Date("2026-09-02T16:00:00Z"),
    });

    // Plantão que cruza o início do horário de verão dos EUA em 2026
    // (2026-03-08 02:00 local -> 03:00 local, America/New_York).
    // O instante UTC precisa ser preservado exatamente como gravado.
    await createApprovedApplication(orgDst.id, doctorAProfileId, {
      specialty: "Cardiologia",
      valueCents: 60000,
      startsAt: new Date("2026-03-08T05:00:00Z"), // 2026-03-08 00:00 EST (antes da mudança)
      endsAt: new Date("2026-03-08T12:00:00Z"), // 2026-03-08 08:00 EDT (depois da mudança)
    });
  });

  afterAll(async () => {
    for (const orgId of [orgHospitalA.id, orgHospitalB.id, orgDst.id]) {
      await tenantContext.withTenantScope(orgId, (tx) => tx.application.deleteMany({ where: { organizationId: orgId } }));
      await tenantContext.withTenantScope(orgId, (tx) => tx.shift.deleteMany({ where: { organizationId: orgId } }));
    }
    await prisma.doctorProfile.deleteMany({ where: { id: { in: [doctorAProfileId, doctorBProfileId] } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgHospitalA.id, orgHospitalB.id, orgDst.id] } } });
    await app.close();
  });

  it("agrega plantões aprovados de hospitais diferentes em um único calendário", async () => {
    const res = await request(app.getHttpServer())
      .get("/calendar")
      .query({ from: "2026-09-01T00:00:00Z", to: "2026-09-10T00:00:00Z" })
      .set("Cookie", cookieFor(doctorA.subject));

    expect(res.status).toBe(200);
    const organizationIds = res.body.map((e: { organizationId: string }) => e.organizationId).sort();
    expect(organizationIds).toEqual([orgHospitalA.id, orgHospitalB.id].sort());
  });

  it("médico recebe apenas seus próprios eventos (candidatura aprovada do Doutor B não aparece)", async () => {
    const res = await request(app.getHttpServer())
      .get("/calendar")
      .query({ from: "2026-09-01T00:00:00Z", to: "2026-09-10T00:00:00Z" })
      .set("Cookie", cookieFor(doctorA.subject));

    expect(res.status).toBe(200);
    expect(res.body.every((e: { valueCents: number }) => e.valueCents !== 42000)).toBe(true);

    const resB = await request(app.getHttpServer())
      .get("/calendar")
      .query({ from: "2026-09-01T00:00:00Z", to: "2026-09-10T00:00:00Z" })
      .set("Cookie", cookieFor(doctorB.subject));
    expect(resB.body).toHaveLength(1);
    expect(resB.body[0].valueCents).toBe(42000);
  });

  it("intervalo cruzando início do horário de verão preserva o instante UTC exato e retorna o timezone IANA do hospital", async () => {
    const res = await request(app.getHttpServer())
      .get("/calendar")
      .query({ from: "2026-03-07T00:00:00Z", to: "2026-03-09T00:00:00Z" })
      .set("Cookie", cookieFor(doctorA.subject));

    expect(res.status).toBe(200);
    const dstEvent = res.body.find((e: { organizationId: string }) => e.organizationId === orgDst.id);
    expect(dstEvent).toBeTruthy();
    expect(new Date(dstEvent.startsAt).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(new Date(dstEvent.endsAt).toISOString()).toBe("2026-03-08T12:00:00.000Z");
    expect(dstEvent.timezone).toBe("America/New_York");
  });

  it("rejeita from/to inválidos com 400", async () => {
    const res = await request(app.getHttpServer())
      .get("/calendar")
      .query({ from: "not-a-date", to: "2026-09-10T00:00:00Z" })
      .set("Cookie", cookieFor(doctorA.subject));
    expect(res.status).toBe(400);
  });

  it("HOSPITAL_ADMIN não consegue usar a rota de calendário do médico (403)", async () => {
    const adminCookie = cookieFor((await prisma.user.findUniqueOrThrow({ where: { id: adminUserId } })).oidcSubject);
    const res = await request(app.getHttpServer())
      .get("/calendar")
      .query({ from: "2026-09-01T00:00:00Z", to: "2026-09-10T00:00:00Z" })
      .set("Cookie", adminCookie);
    expect(res.status).toBe(403);
  });
});
