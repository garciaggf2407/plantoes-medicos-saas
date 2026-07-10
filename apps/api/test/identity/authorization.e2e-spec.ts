import { beforeAll, afterAll, describe, expect, it } from "vitest";
import cookieParser from "cookie-parser";
import { Controller, Get, Module, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { UserRole } from "@prisma/client";
import { AppModule } from "../../src/app.module";
import { PrismaModule } from "../../src/prisma/prisma.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { SessionService, type SessionPayload } from "../../src/identity/session.service";
import { Public } from "../../src/identity/decorators/public.decorator";
import { Roles } from "../../src/identity/decorators/roles.decorator";

process.env.SESSION_SECRET ??= "test-only-session-secret-32-characters";
process.env.OIDC_ISSUER_URL = "";
process.env.COOKIE_SECURE ??= "true";

/**
 * Controller de teste representando rotas sensíveis com diferentes
 * matrizes de papel, usado apenas para exercitar AuthenticationGuard
 * e AuthorizationGuard de ponta a ponta.
 */
@Controller("test-sensitive")
class SensitiveTestController {
  @Get("public")
  @Public()
  publicRoute() {
    return { ok: true };
  }

  @Get("doctor-only")
  @Roles(UserRole.DOCTOR)
  doctorOnly() {
    return { ok: true };
  }

  @Get("admin-only")
  @Roles(UserRole.HOSPITAL_ADMIN)
  adminOnly() {
    return { ok: true };
  }

  @Get("superadmin-only")
  @Roles(UserRole.SUPERADMIN)
  superadminOnly() {
    return { ok: true };
  }

  @Get("admin-or-superadmin")
  @Roles(UserRole.HOSPITAL_ADMIN, UserRole.SUPERADMIN)
  adminOrSuperadmin() {
    return { ok: true };
  }

  /** Sem @Public() e sem @Roles() — deve ser negada por padrão. */
  @Get("no-roles-declared")
  noRolesDeclared() {
    return { ok: true };
  }
}

@Module({
  imports: [PrismaModule],
  controllers: [SensitiveTestController],
})
class TestFixtureModule {}

describe("RBAC (integração — matriz de papéis)", () => {
  let app: INestApplication;
  let sessions: SessionService;
  let prisma: PrismaService;

  const users: Record<UserRole, { subject: string; email: string }> = {
    DOCTOR: { subject: `doctor-${randomUUID()}`, email: `doctor-${randomUUID()}@example.com` },
    HOSPITAL_ADMIN: { subject: `admin-${randomUUID()}`, email: `admin-${randomUUID()}@example.com` },
    SUPERADMIN: { subject: `super-${randomUUID()}`, email: `super-${randomUUID()}@example.com` },
  };

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
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, TestFixtureModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    sessions = moduleRef.get(SessionService);
    prisma = moduleRef.get(PrismaService);

    for (const [role, identity] of Object.entries(users) as [UserRole, { subject: string; email: string }][]) {
      await prisma.user.create({
        data: {
          oidcSubject: identity.subject,
          email: identity.email,
          role,
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { oidcSubject: { in: Object.values(users).map((u) => u.subject) } },
    });
    await app.close();
  });

  it("rota @Public() é acessível sem sessão", async () => {
    const res = await request(app.getHttpServer()).get("/test-sensitive/public");
    expect(res.status).toBe(200);
  });

  it("rota autenticada sem sessão retorna 401", async () => {
    const res = await request(app.getHttpServer()).get("/test-sensitive/doctor-only");
    expect(res.status).toBe(401);
  });

  it("rota sem @Roles() declarado é negada por padrão (default deny) mesmo autenticado", async () => {
    const res = await request(app.getHttpServer())
      .get("/test-sensitive/no-roles-declared")
      .set("Cookie", cookieFor(users.SUPERADMIN.subject));
    expect(res.status).toBe(403);
  });

  it.each([
    ["DOCTOR", "doctor-only", 200],
    ["HOSPITAL_ADMIN", "doctor-only", 403],
    ["SUPERADMIN", "doctor-only", 403],

    ["DOCTOR", "admin-only", 403],
    ["HOSPITAL_ADMIN", "admin-only", 200],
    ["SUPERADMIN", "admin-only", 403],

    ["DOCTOR", "superadmin-only", 403],
    ["HOSPITAL_ADMIN", "superadmin-only", 403],
    ["SUPERADMIN", "superadmin-only", 200],

    ["DOCTOR", "admin-or-superadmin", 403],
    ["HOSPITAL_ADMIN", "admin-or-superadmin", 200],
    ["SUPERADMIN", "admin-or-superadmin", 200],
  ] as const)("papel %s em /%s -> %i", async (role, route, expectedStatus) => {
    const res = await request(app.getHttpServer())
      .get(`/test-sensitive/${route}`)
      .set("Cookie", cookieFor(users[role as UserRole].subject));
    expect(res.status).toBe(expectedStatus);
  });
});
