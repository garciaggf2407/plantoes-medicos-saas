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

describe("POST /credentials/:id/review (integração — revisão manual de credencial)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionService;
  let tenantContext: TenantContextService;

  const doctor = { subject: `doctor-${randomUUID()}`, email: `doctor-${randomUUID()}@example.com` };
  const adminSameOrg = { subject: `admin-a-${randomUUID()}`, email: `admin-a-${randomUUID()}@example.com` };
  const adminOtherOrg = { subject: `admin-b-${randomUUID()}`, email: `admin-b-${randomUUID()}@example.com` };

  let orgA: { id: string };
  let orgB: { id: string };
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

  async function submitFreshCredential(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/doctors/me/credentials")
      .set("Cookie", cookieFor(doctor.subject))
      .send({ organizationId: orgA.id, evidenceUrl: `https://files.example.com/${randomUUID()}.pdf` });
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

    const users = await Promise.all([
      prisma.user.create({ data: { oidcSubject: doctor.subject, email: doctor.email, role: UserRole.DOCTOR } }),
      prisma.user.create({
        data: { oidcSubject: adminSameOrg.subject, email: adminSameOrg.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgA.id },
      }),
      prisma.user.create({
        data: { oidcSubject: adminOtherOrg.subject, email: adminOtherOrg.email, role: UserRole.HOSPITAL_ADMIN, organizationId: orgB.id },
      }),
    ]);
    createdUserIds.push(...users.map((u) => u.id));

    await request(app.getHttpServer())
      .put("/doctors/me/profile")
      .set("Cookie", cookieFor(doctor.subject))
      .send({ crmNumber: "CRM-REVIEW-1", specialties: ["Cardiologia"] });
  });

  afterAll(async () => {
    await tenantContext.withTenantScope(orgA.id, (tx) => tx.credential.deleteMany({ where: { organizationId: orgA.id } }));
    // audit_logs agora é imutável para a role de runtime (sem DELETE) —
    // limpeza de teste usa uma conexão privilegiada dedicada.
    const admin = createAdminPrismaForTestCleanup();
    await admin.auditLog.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
    await admin.$disconnect();

    await prisma.doctorProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await app.close();
  });

  it("somente hospital_admin do hospital vinculado decide: DOCTOR recebe 403", async () => {
    const credentialId = await submitFreshCredential();
    const res = await request(app.getHttpServer())
      .post(`/credentials/${credentialId}/review`)
      .set("Cookie", cookieFor(doctor.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "Documentação conferida" });
    expect(res.status).toBe(403);
  });

  it("somente hospital_admin do hospital vinculado decide: admin de OUTRO hospital recebe 403", async () => {
    const credentialId = await submitFreshCredential();
    const res = await request(app.getHttpServer())
      .post(`/credentials/${credentialId}/review`)
      .set("Cookie", cookieFor(adminOtherOrg.subject))
      .send({ organizationId: orgB.id, decision: "APPROVED", justification: "Documentação conferida" });
    // admin de org-B tentando revisar organizationId=orgB, mas a credencial pertence a org-A -> NotFound sob RLS
    expect([403, 404]).toContain(res.status);
  });

  it("aprova credencial pendente com justificativa — registra ator, data e justificativa", async () => {
    const credentialId = await submitFreshCredential();
    const res = await request(app.getHttpServer())
      .post(`/credentials/${credentialId}/review`)
      .set("Cookie", cookieFor(adminSameOrg.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "CRM verificado no site do conselho" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("APPROVED");
    expect(res.body.justification).toBe("CRM verificado no site do conselho");
    expect(res.body.reviewedAt).toBeTruthy();

    const adminUser = await prisma.user.findUniqueOrThrow({ where: { oidcSubject: adminSameOrg.subject } });
    expect(res.body.reviewedByUserId).toBe(adminUser.id);

    const auditEntries = await tenantContext.withTenantScope(orgA.id, (tx) =>
      tx.auditLog.findMany({ where: { targetType: "Credential", targetId: credentialId, action: "credential.approved" } }),
    );
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]?.actorUserId).toBe(adminUser.id);
    expect(auditEntries[0]?.justification).toBe("CRM verificado no site do conselho");
    expect(auditEntries[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("rejeita justificativa vazia com 400", async () => {
    const credentialId = await submitFreshCredential();
    const res = await request(app.getHttpServer())
      .post(`/credentials/${credentialId}/review`)
      .set("Cookie", cookieFor(adminSameOrg.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "  " });
    expect(res.status).toBe(400);
  });

  it("transição de estado inválida é rejeitada: REJECTED -> APPROVED", async () => {
    const credentialId = await submitFreshCredential();
    await request(app.getHttpServer())
      .post(`/credentials/${credentialId}/review`)
      .set("Cookie", cookieFor(adminSameOrg.subject))
      .send({ organizationId: orgA.id, decision: "REJECTED", justification: "Documento ilegível" });

    const res = await request(app.getHttpServer())
      .post(`/credentials/${credentialId}/review`)
      .set("Cookie", cookieFor(adminSameOrg.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "Tentando reverter" });
    expect(res.status).toBe(400);
  });

  it("transição de estado inválida é rejeitada: PENDING -> EXPIRED", async () => {
    const credentialId = await submitFreshCredential();
    const res = await request(app.getHttpServer())
      .post(`/credentials/${credentialId}/review`)
      .set("Cookie", cookieFor(adminSameOrg.subject))
      .send({ organizationId: orgA.id, decision: "EXPIRED", justification: "Tentando expirar sem aprovação" });
    expect(res.status).toBe(400);
  });

  it("transição válida APPROVED -> EXPIRED funciona", async () => {
    const credentialId = await submitFreshCredential();
    await request(app.getHttpServer())
      .post(`/credentials/${credentialId}/review`)
      .set("Cookie", cookieFor(adminSameOrg.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "Aprovado" });

    const res = await request(app.getHttpServer())
      .post(`/credentials/${credentialId}/review`)
      .set("Cookie", cookieFor(adminSameOrg.subject))
      .send({ organizationId: orgA.id, decision: "EXPIRED", justification: "Validade CRM vencida" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("EXPIRED");
  });

  it("auditoria é imutável: role de runtime não consegue apagar nem alterar audit_logs no banco", async () => {
    const credentialId = await submitFreshCredential();
    await request(app.getHttpServer())
      .post(`/credentials/${credentialId}/review`)
      .set("Cookie", cookieFor(adminSameOrg.subject))
      .send({ organizationId: orgA.id, decision: "APPROVED", justification: "Aprovado para teste de imutabilidade" });

    await expect(
      tenantContext.withTenantScope(orgA.id, (tx) =>
        tx.auditLog.deleteMany({ where: { targetType: "Credential", targetId: credentialId } }),
      ),
    ).rejects.toThrow();

    await expect(
      tenantContext.withTenantScope(orgA.id, (tx) =>
        tx.auditLog.updateMany({
          where: { targetType: "Credential", targetId: credentialId },
          data: { justification: "adulterado" },
        }),
      ),
    ).rejects.toThrow();
  });
});
