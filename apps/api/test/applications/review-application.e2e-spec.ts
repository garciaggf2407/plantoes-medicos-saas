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
import { createAdminPrismaForTestCleanup } from "../support/admin-prisma";

process.env.SESSION_SECRET ??= "test-only-session-secret-32-characters";
process.env.OIDC_ISSUER_URL = "";
process.env.COOKIE_SECURE ??= "true";
process.env.DATABASE_URL =
  "postgresql://plantoes_app:plantoes_app_dev_local@localhost:5432/plantoes_medicos?schema=public";

describe("POST /applications/:id/review (integração — decisão de candidatura)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;

  const adminA = { subject: `admin-a-${randomUUID()}`, email: `admin-a-${randomUUID()}@example.com` };
  const adminB = { subject: `admin-b-${randomUUID()}`, email: `admin-b-${randomUUID()}@example.com` };
  let orgA: { id: string };
  let orgB: { id: string };
  let adminAUserId: string;
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

  async function makeDoctorWithApprovedCredential(specialty: string): Promise<{ subject: string; profileId: string }> {
    const subject = `doctor-${randomUUID()}`;
    const user = await prisma.user.create({
      data: { oidcSubject: subject, email: `doctor-${randomUUID()}@example.com`, role: UserRole.DOCTOR },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.doctorProfile.create({
      data: { userId: user.id, crmNumber: `CRM-${randomUUID()}`, specialties: [specialty] },
    });
    await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.credential.create({
        data: { doctorProfileId: profile.id, organizationId: orgA.id, evidenceUrl: "https://files.example.com/x.pdf", status: "APPROVED", reviewedByUserId: adminAUserId, reviewedAt: new Date() },
      }),
    );
    return { subject, profileId: profile.id };
  }

  async function createShift(overrides: Record<string, unknown> = {}): Promise<string> {
    const shift = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.shift.create({
        data: {
          organizationId: orgA.id,
          specialty: "Cardiologia",
          valueCents: 50000,
          startsAt: new Date("2026-10-01T08:00:00Z"),
          endsAt: new Date("2026-10-01T16:00:00Z"),
          status: "PUBLISHED",
          createdByUserId: adminAUserId,
          ...overrides,
        },
      }),
    );
    return shift.id;
  }

  async function applyAsDoctor(subject: string, shiftId: string) {
    const res = await request(app.getHttpServer())
      .post("/applications")
      .set("Cookie", cookieFor(subject))
      .send({ shiftId, organizationId: orgA.id });
    return res.body.id as string;
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
    const adminBUser = await prisma.user.create({
      data: { oidcSubject: adminB.subject, email: adminB.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgB.id },
    });
    createdUserIds.push(adminAUser.id, adminBUser.id);
    adminAUserId = adminAUser.id;
  });

  afterAll(async () => {
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.application.deleteMany({ where: { organizationId: orgA.id } }));
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.credential.deleteMany({ where: { organizationId: orgA.id } }));
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.shift.deleteMany({ where: { organizationId: orgA.id } }));

    const admin = createAdminPrismaForTestCleanup();
    await admin.notification.deleteMany({ where: { organizationId: { in: [orgA.id, orgB.id] } } });
    await admin.emailDelivery.deleteMany({ where: { organizationId: { in: [orgA.id, orgB.id] } } });
    await admin.outboxEvent.deleteMany({ where: { organizationId: { in: [orgA.id, orgB.id] } } });
    await admin.auditLog.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
    await admin.$disconnect();

    await prisma.doctorProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await app.close();
  });

  it("DOCTOR não consegue revisar candidatura (403)", async () => {
    const doctor = await makeDoctorWithApprovedCredential("Cardiologia");
    const shiftId = await createShift();
    const applicationId = await applyAsDoctor(doctor.subject, shiftId);

    const res = await request(app.getHttpServer())
      .post(`/applications/${applicationId}/review`)
      .set("Cookie", cookieFor(doctor.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "Aprovado" });
    expect(res.status).toBe(403);
  });

  it("admin de outro hospital não consegue revisar (404 sob RLS)", async () => {
    const doctor = await makeDoctorWithApprovedCredential("Cardiologia");
    const shiftId = await createShift();
    const applicationId = await applyAsDoctor(doctor.subject, shiftId);

    const res = await request(app.getHttpServer())
      .post(`/applications/${applicationId}/review`)
      .set("Cookie", cookieFor(adminB.subject))
      .send({ organizationId: orgB.id, decision: "APPROVED", justification: "Aprovado" });
    expect([403, 404]).toContain(res.status);
  });

  it("rejeita justificativa vazia com 400", async () => {
    const doctor = await makeDoctorWithApprovedCredential("Cardiologia");
    const shiftId = await createShift();
    const applicationId = await applyAsDoctor(doctor.subject, shiftId);

    const res = await request(app.getHttpServer())
      .post(`/applications/${applicationId}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: " " });
    expect(res.status).toBe(400);
  });

  it("aprova candidatura: plantão vira FILLED, decisão e justificativa aparecem na auditoria", async () => {
    const doctor = await makeDoctorWithApprovedCredential("Cardiologia");
    const shiftId = await createShift();
    const applicationId = await applyAsDoctor(doctor.subject, shiftId);

    const res = await request(app.getHttpServer())
      .post(`/applications/${applicationId}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "CRM e disponibilidade conferidos" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("APPROVED");

    const shift = await tenantContext.withTenantScope(orgA.id, (tx) => tx.shift.findUniqueOrThrow({ where: { id: shiftId } }));
    expect(shift.status).toBe("FILLED");

    const auditEntries = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.auditLog.findMany({ where: { targetType: "Application", targetId: applicationId, action: "application.approved" } }),
    );
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]?.actorUserId).toBe(adminAUserId);
    expect(auditEntries[0]?.justification).toBe("CRM e disponibilidade conferidos");
  });

  it("aprovar uma candidatura auto-rejeita outras candidaturas PENDING do mesmo plantão", async () => {
    const shiftId = await createShift();
    const doctor1 = await makeDoctorWithApprovedCredential("Cardiologia");
    const doctor2 = await makeDoctorWithApprovedCredential("Cardiologia");
    const app1 = await applyAsDoctor(doctor1.subject, shiftId);
    const app2 = await applyAsDoctor(doctor2.subject, shiftId);

    await request(app.getHttpServer())
      .post(`/applications/${app1}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "Primeiro aprovado" });

    const app2Row = await tenantContext.withTenantScope(orgA.id, (tx) => tx.application.findUniqueOrThrow({ where: { id: app2 } }));
    expect(app2Row.status).toBe("REJECTED");
  });

  it("rejeita justificativa e mantém plantão PUBLISHED", async () => {
    const doctor = await makeDoctorWithApprovedCredential("Cardiologia");
    const shiftId = await createShift();
    const applicationId = await applyAsDoctor(doctor.subject, shiftId);

    const res = await request(app.getHttpServer())
      .post(`/applications/${applicationId}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "REJECTED", justification: "Documentação incompleta" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("REJECTED");

    const shift = await tenantContext.withTenantScope(orgA.id, (tx) => tx.shift.findUniqueOrThrow({ where: { id: shiftId } }));
    expect(shift.status).toBe("PUBLISHED");
  });

  it("reenvio da mesma decisão é idempotente (sem erro)", async () => {
    const doctor = await makeDoctorWithApprovedCredential("Cardiologia");
    const shiftId = await createShift();
    const applicationId = await applyAsDoctor(doctor.subject, shiftId);

    await request(app.getHttpServer())
      .post(`/applications/${applicationId}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "Aprovado" });

    const second = await request(app.getHttpServer())
      .post(`/applications/${applicationId}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "Aprovado de novo" });
    expect(second.status).toBe(201);
    expect(second.body.status).toBe("APPROVED");
  });

  it("transição inválida (APPROVED -> REJECTED) é rejeitada com 400", async () => {
    const doctor = await makeDoctorWithApprovedCredential("Cardiologia");
    const shiftId = await createShift();
    const applicationId = await applyAsDoctor(doctor.subject, shiftId);

    await request(app.getHttpServer())
      .post(`/applications/${applicationId}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "Aprovado" });

    const res = await request(app.getHttpServer())
      .post(`/applications/${applicationId}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "REJECTED", justification: "Tentando reverter" });
    expect(res.status).toBe(400);
  });

  it("concorrência: duas aprovações simultâneas para o mesmo plantão — só uma vence (SC-5)", async () => {
    const shiftId = await createShift();
    const doctor1 = await makeDoctorWithApprovedCredential("Cardiologia");
    const doctor2 = await makeDoctorWithApprovedCredential("Cardiologia");
    const app1 = await applyAsDoctor(doctor1.subject, shiftId);
    const app2 = await applyAsDoctor(doctor2.subject, shiftId);

    const [res1, res2] = await Promise.all([
      request(app.getHttpServer())
        .post(`/applications/${app1}/review`)
        .set("Cookie", cookieFor(adminA.subject))
        .send({ organizationId: orgA.id, decision: "APPROVED", justification: "Aprovando candidato 1" }),
      request(app.getHttpServer())
        .post(`/applications/${app2}/review`)
        .set("Cookie", cookieFor(adminA.subject))
        .send({ organizationId: orgA.id, decision: "APPROVED", justification: "Aprovando candidato 2" }),
    ]);

    // Exatamente uma aprovação vence (2xx); nunca as duas. A perdedora
    // recebe 409 (bateu de frente com a constraint de unicidade do
    // banco) OU 400 (perdeu a corrida antes mesmo de tentar seu
    // próprio UPDATE, porque o auto-reject da vencedora já havia
    // marcado sua candidatura como REJECTED) — a ordem exata depende
    // do agendamento do event loop/pool de conexões, mas em ambos os
    // casos a garantia real (só uma aprovação, nunca duas) se mantém.
    const successCount = [res1, res2].filter((r) => r.status >= 200 && r.status < 300).length;
    expect(successCount).toBe(1);
    const loserStatus = res1.status >= 200 && res1.status < 300 ? res2.status : res1.status;
    expect([400, 409]).toContain(loserStatus);

    const approvedCount = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.application.count({ where: { shiftId, status: "APPROVED" } }),
    );
    expect(approvedCount).toBe(1);

    const shift = await tenantContext.withTenantScope(orgA.id, (tx) => tx.shift.findUniqueOrThrow({ where: { id: shiftId } }));
    expect(shift.status).toBe("FILLED");
  });

  it("bug real corrigido (auditoria): médico não pode ser aprovado em dois plantões com horário sobreposto", async () => {
    // apply-to-shift.use-case.ts só bloqueia conflito contra
    // candidaturas já APROVADAS -- duas candidaturas PENDING para
    // plantões sobrepostos passam essa checagem (nenhuma é APPROVED
    // ainda). Sem revalidar no momento da decisão, aprovar as duas
    // separadamente resultava em duplo agendamento físico.
    const doctor = await makeDoctorWithApprovedCredential("Cardiologia");
    const shiftA = await createShift({
      startsAt: new Date("2026-11-01T10:00:00Z"),
      endsAt: new Date("2026-11-01T12:00:00Z"),
    });
    const shiftB = await createShift({
      startsAt: new Date("2026-11-01T11:00:00Z"),
      endsAt: new Date("2026-11-01T13:00:00Z"),
    });
    const appA = await applyAsDoctor(doctor.subject, shiftA);
    const appB = await applyAsDoctor(doctor.subject, shiftB);

    const firstApproval = await request(app.getHttpServer())
      .post(`/applications/${appA}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "Primeiro plantão aprovado" });
    expect(firstApproval.status).toBe(201);

    const secondApproval = await request(app.getHttpServer())
      .post(`/applications/${appB}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "Segundo plantão, sobreposto" });
    expect(secondApproval.status).toBe(409);
    expect(secondApproval.body.message?.error ?? secondApproval.body.error).toBe("schedule_conflict");

    const appBRow = await tenantContext.withTenantScope(orgA.id, (tx) => tx.application.findUniqueOrThrow({ where: { id: appB } }));
    expect(appBRow.status).toBe("PENDING");

    const shiftBRow = await tenantContext.withTenantScope(orgA.id, (tx) => tx.shift.findUniqueOrThrow({ where: { id: shiftB } }));
    expect(shiftBRow.status).toBe("PUBLISHED");
  });

  it("bug real corrigido (auditoria): candidatura não pode ser aprovada se a credencial do médico foi revogada depois da candidatura", async () => {
    const doctor = await makeDoctorWithApprovedCredential("Cardiologia");
    const shiftId = await createShift();
    const applicationId = await applyAsDoctor(doctor.subject, shiftId);

    await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.credential.update({
        where: { doctorProfileId_organizationId: { doctorProfileId: doctor.profileId, organizationId: orgA.id } },
        data: { status: "REJECTED" },
      }),
    );

    const res = await request(app.getHttpServer())
      .post(`/applications/${applicationId}/review`)
      .set("Cookie", cookieFor(adminA.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "Aprovando sem reconferir credencial" });
    expect(res.status).toBe(409);
    expect(res.body.message?.error ?? res.body.error).toBe("credential_not_approved");

    const shift = await tenantContext.withTenantScope(orgA.id, (tx) => tx.shift.findUniqueOrThrow({ where: { id: shiftId } }));
    expect(shift.status).toBe("PUBLISHED");
  });
});
