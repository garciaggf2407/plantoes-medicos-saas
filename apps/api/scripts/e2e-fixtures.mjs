#!/usr/bin/env node
// Fixture/verificação para o E2E Playwright (T-5.2.1, apps/web/e2e/success-criteria.spec.ts).
//
// Não existe fluxo self-service para virar hospital_admin/superadmin
// (por desenho: só convite/provisionamento privilegiado -- ver
// AuthService.resolveOrProvisionUser), nem endpoint HTTP para
// inspecionar EmailDelivery (T-5.1.4 não precisou de um). Este script
// usa acesso direto ao Prisma para (a) semear dados de cenário antes
// de dirigir o app pelo navegador/HTTP real, e (b) verificar efeitos
// que não têm UI própria (entrega de email) -- exatamente o mesmo
// padrão de admin-prisma.ts já usado pela própria suíte de testes da
// API. Todo dado criado é marcado com o prefixo e2e-<cenario>-, então
// cleanup nunca depende de IDs devolvidos por uma execução anterior.
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const APP_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://plantoes_app:plantoes_app_dev_local@localhost:5432/plantoes_medicos?schema=public";
const ADMIN_DATABASE_URL =
  process.env.ADMIN_DATABASE_URL ?? "postgresql://postgres:athena_dev_local@localhost:5432/plantoes_medicos?schema=public";

const prisma = new PrismaClient({ datasources: { db: { url: APP_DATABASE_URL } } });
const adminPrisma = new PrismaClient({ datasources: { db: { url: ADMIN_DATABASE_URL } } });

function withTenantScope(organizationId, fn) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true)`;
    return fn(tx);
  });
}

function withActorScope(userId, fn) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_actor_user_id', ${userId}, true)`;
    return fn(tx);
  });
}

function tag() {
  return randomUUID().slice(0, 8);
}

async function createOrgAndAdmin(scenario, suffix) {
  const org = await prisma.organization.create({
    data: { name: `e2e-${scenario}-org-${suffix}`, timezone: "America/Sao_Paulo" },
  });
  const admin = await prisma.user.create({
    data: {
      oidcSubject: `e2e-${scenario}-admin-${suffix}`,
      email: `e2e-${scenario}-admin-${suffix}@example.com`,
      role: "HOSPITAL_ADMIN",
      organizationId: org.id,
    },
  });
  return { org, admin };
}

async function createCredentialedDoctor(scenario, suffix, organizationId, adminUserId, specialty, doctorSuffix = "") {
  const doctor = await prisma.user.create({
    data: {
      oidcSubject: `e2e-${scenario}-doctor${doctorSuffix}-${suffix}`,
      email: `e2e-${scenario}-doctor${doctorSuffix}-${suffix}@example.com`,
      role: "DOCTOR",
    },
  });
  const profile = await prisma.doctorProfile.create({
    data: { userId: doctor.id, crmNumber: `CRM-${suffix}${doctorSuffix}`, specialties: [specialty] },
  });
  await withTenantScope(organizationId, (tx) =>
    tx.credential.create({
      data: {
        doctorProfileId: profile.id,
        organizationId,
        evidenceUrl: "https://files.example.com/crm.pdf",
        status: "APPROVED",
        reviewedByUserId: adminUserId,
        reviewedAt: new Date(),
      },
    }),
  );
  return { doctor, profile };
}

async function seedSc1() {
  const suffix = tag();
  const { org, admin } = await createOrgAndAdmin("sc1", suffix);
  const { doctor } = await createCredentialedDoctor("sc1", suffix, org.id, admin.id, "Cardiologia");
  const shift = await withTenantScope(org.id, (tx) =>
    tx.shift.create({
      data: {
        organizationId: org.id,
        specialty: "Cardiologia",
        valueCents: 80000,
        startsAt: new Date("2026-10-01T08:00:00Z"),
        endsAt: new Date("2026-10-01T16:00:00Z"),
        status: "PUBLISHED",
        createdByUserId: admin.id,
      },
    }),
  );
  return {
    orgId: org.id,
    orgName: org.name,
    adminSubject: admin.oidcSubject,
    adminEmail: admin.email,
    doctorSubject: doctor.oidcSubject,
    doctorEmail: doctor.email,
    shiftId: shift.id,
    specialty: "Cardiologia",
  };
}

async function seedSc2() {
  const suffix = tag();
  const { org, admin } = await createOrgAndAdmin("sc2", suffix);
  const { doctor } = await createCredentialedDoctor("sc2", suffix, org.id, admin.id, "Ortopedia");
  return {
    orgId: org.id,
    adminSubject: admin.oidcSubject,
    adminEmail: admin.email,
    doctorSubject: doctor.oidcSubject,
    doctorEmail: doctor.email,
    specialty: "Ortopedia",
  };
}

async function seedSc3() {
  const suffixA = tag();
  const { org: orgA, admin: adminA } = await createOrgAndAdmin("sc3", suffixA);
  const suffixB = `${suffixA}-b`;
  const adminB = await prisma.user.create({
    data: {
      oidcSubject: `e2e-sc3-admin-${suffixB}`,
      email: `e2e-sc3-admin-${suffixB}@example.com`,
      role: "HOSPITAL_ADMIN",
      organizationId: (
        await prisma.organization.create({ data: { name: `e2e-sc3-org-${suffixB}`, timezone: "America/Sao_Paulo" } })
      ).id,
    },
  });
  const orgB = await prisma.organization.findUniqueOrThrow({ where: { id: adminB.organizationId } });

  const shiftInOrgA = await withTenantScope(orgA.id, (tx) =>
    tx.shift.create({
      data: {
        organizationId: orgA.id,
        specialty: "Neurologia",
        valueCents: 90000,
        startsAt: new Date("2026-10-02T08:00:00Z"),
        endsAt: new Date("2026-10-02T16:00:00Z"),
        status: "PUBLISHED",
        createdByUserId: adminA.id,
      },
    }),
  );

  return {
    orgAId: orgA.id,
    orgBId: orgB.id,
    adminASubject: adminA.oidcSubject,
    adminAEmail: adminA.email,
    adminBSubject: adminB.oidcSubject,
    adminBEmail: adminB.email,
    shiftIdInOrgA: shiftInOrgA.id,
  };
}

async function seedSc4() {
  const suffix = tag();
  const { org, admin } = await createOrgAndAdmin("sc4", suffix);
  const { doctor } = await createCredentialedDoctor("sc4", suffix, org.id, admin.id, "Pediatria");
  return {
    orgId: org.id,
    adminSubject: admin.oidcSubject,
    adminEmail: admin.email,
    doctorSubject: doctor.oidcSubject,
    doctorEmail: doctor.email,
    doctorUserId: doctor.id,
    specialty: "Pediatria",
  };
}

async function seedSc5() {
  const suffix = tag();
  const { org, admin } = await createOrgAndAdmin("sc5", suffix);
  const { doctor: doctor1, profile: profile1 } = await createCredentialedDoctor("sc5", suffix, org.id, admin.id, "Cardiologia", "1");
  const { doctor: doctor2, profile: profile2 } = await createCredentialedDoctor("sc5", suffix, org.id, admin.id, "Cardiologia", "2");
  const shift = await withTenantScope(org.id, (tx) =>
    tx.shift.create({
      data: {
        organizationId: org.id,
        specialty: "Cardiologia",
        valueCents: 70000,
        startsAt: new Date("2026-10-03T08:00:00Z"),
        endsAt: new Date("2026-10-03T16:00:00Z"),
        status: "PUBLISHED",
        createdByUserId: admin.id,
      },
    }),
  );
  const app1 = await withTenantScope(org.id, (tx) =>
    tx.application.create({ data: { shiftId: shift.id, doctorProfileId: profile1.id, organizationId: org.id, status: "PENDING" } }),
  );
  const app2 = await withTenantScope(org.id, (tx) =>
    tx.application.create({ data: { shiftId: shift.id, doctorProfileId: profile2.id, organizationId: org.id, status: "PENDING" } }),
  );

  return {
    orgId: org.id,
    adminSubject: admin.oidcSubject,
    adminEmail: admin.email,
    shiftId: shift.id,
    application1Id: app1.id,
    application2Id: app2.id,
    doctor1Subject: doctor1.oidcSubject,
    doctor2Subject: doctor2.oidcSubject,
  };
}

const SEEDERS = { sc1: seedSc1, sc2: seedSc2, sc3: seedSc3, sc4: seedSc4, sc5: seedSc5 };

async function cleanup(scenario) {
  const prefix = `e2e-${scenario}-`;
  const orgs = await prisma.organization.findMany({ where: { name: { startsWith: prefix } } });
  const orgIds = orgs.map((o) => o.id);
  const users = await prisma.user.findMany({ where: { oidcSubject: { startsWith: prefix } } });
  const userIds = users.map((u) => u.id);

  for (const orgId of orgIds) {
    await withTenantScope(orgId, (tx) => tx.application.deleteMany({ where: { organizationId: orgId } }));
    await withTenantScope(orgId, (tx) => tx.credential.deleteMany({ where: { organizationId: orgId } }));
    await withTenantScope(orgId, (tx) => tx.shift.deleteMany({ where: { organizationId: orgId } }));
  }
  if (orgIds.length > 0) {
    await adminPrisma.notification.deleteMany({ where: { organizationId: { in: orgIds } } });
    await adminPrisma.emailDelivery.deleteMany({ where: { organizationId: { in: orgIds } } });
    await adminPrisma.outboxEvent.deleteMany({ where: { organizationId: { in: orgIds } } });
  }
  if (userIds.length > 0) {
    await adminPrisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  }
  await prisma.doctorProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });

  return { orgIds, userIds };
}

async function checkNotification(userId, type) {
  const row = await withActorScope(userId, (tx) =>
    tx.notification.findFirst({ where: { userId, type }, orderBy: { createdAt: "desc" } }),
  );
  return { found: !!row, notification: row };
}

async function checkEmailDelivery(organizationId, userId) {
  const row = await withTenantScope(organizationId, (tx) =>
    tx.emailDelivery.findFirst({ where: { organizationId, userId }, orderBy: { createdAt: "desc" } }),
  );
  return { found: !!row };
}

async function main() {
  const [, , command, ...args] = process.argv;
  let result;
  switch (command) {
    case "seed": {
      const scenario = args[0];
      const seeder = SEEDERS[scenario];
      if (!seeder) throw new Error(`Cenário desconhecido: ${scenario}`);
      result = await seeder();
      break;
    }
    case "cleanup":
      result = await cleanup(args[0]);
      break;
    case "check-notification":
      result = await checkNotification(args[0], args[1]);
      break;
    case "check-email-delivery":
      result = await checkEmailDelivery(args[0], args[1]);
      break;
    default:
      throw new Error(`Comando desconhecido: ${command}`);
  }
  process.stdout.write(JSON.stringify(result));
}

main()
  .catch((err) => {
    process.stderr.write(String(err?.stack ?? err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await adminPrisma.$disconnect();
  });
