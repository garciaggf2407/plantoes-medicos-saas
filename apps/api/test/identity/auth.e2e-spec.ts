import { beforeAll, afterAll, describe, expect, it } from "vitest";
import cookieParser from "cookie-parser";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../../src/app.module";
import { FakeOidcProvider } from "../../src/identity/providers/fake-oidc.provider";

process.env.SESSION_SECRET ??= "test-only-session-secret-32-characters";
process.env.OIDC_ISSUER_URL = "";
process.env.COOKIE_SECURE ??= "true";
process.env.DATABASE_URL ??=
  "postgresql://plantoes_app:plantoes_app_dev_local@localhost:5432/plantoes_medicos?schema=public";

describe("Auth (integração — login/callback/logout)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  function extractCookie(setCookieHeader: string[], name: string): string {
    const found = setCookieHeader.find((c) => c.startsWith(`${name}=`));
    if (!found) {
      throw new Error(`Cookie ${name} não encontrado em Set-Cookie`);
    }
    return found.split(";")[0]!;
  }

  it("GET /auth/login redireciona para o provedor e emite cookie de estado pendente (HttpOnly)", async () => {
    const res = await request(app.getHttpServer()).get("/auth/login");

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("fake-oidc.local/authorize");
    expect(res.headers.location).toMatch(/state=/);

    const setCookie = res.headers["set-cookie"] as unknown as string[];
    const pendingCookie = extractCookie(setCookie, "plantoes_auth_pending");
    expect(setCookie.join(";")).toMatch(/HttpOnly/i);
    expect(pendingCookie).toBeTruthy();
  });

  it("fluxo completo: login -> callback com code válido emite sessão Secure/HttpOnly/SameSite -> logout limpa a sessão", async () => {
    const loginRes = await request(app.getHttpServer()).get("/auth/login");
    const pendingCookie = extractCookie(loginRes.headers["set-cookie"] as unknown as string[], "plantoes_auth_pending");
    const state = new URL(loginRes.headers.location).searchParams.get("state");
    expect(state).toBeTruthy();

    const code = FakeOidcProvider.encodeCode("doctor-123", "medico@example.com");

    const callbackRes = await request(app.getHttpServer())
      .get("/auth/callback")
      .set("Cookie", pendingCookie)
      .query({ code, state });

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toBe("/");

    const callbackCookies = callbackRes.headers["set-cookie"] as unknown as string[];
    const sessionCookieHeader = callbackCookies.find((c) => c.startsWith("plantoes_session="));
    expect(sessionCookieHeader).toBeTruthy();
    expect(sessionCookieHeader).toMatch(/HttpOnly/i);
    expect(sessionCookieHeader).toMatch(/Secure/i);
    expect(sessionCookieHeader).toMatch(/SameSite=Lax/i);

    const sessionCookie = extractCookie(callbackCookies, "plantoes_session");

    const logoutRes = await request(app.getHttpServer())
      .post("/auth/logout")
      .set("Cookie", sessionCookie);

    expect(logoutRes.status).toBe(200);
    const logoutCookies = logoutRes.headers["set-cookie"] as unknown as string[];
    const clearedSession = logoutCookies.find((c) => c.startsWith("plantoes_session="));
    expect(clearedSession).toMatch(/plantoes_session=;/);
  });

  it("callback com erro do provedor retorna 400 sem lançar exceção não tratada", async () => {
    const res = await request(app.getHttpServer())
      .get("/auth/callback")
      .query({ error: "access_denied" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("authentication_failed");
    expect(res.body.reason).toContain("access_denied");
  });

  it("callback sem code/state retorna 400", async () => {
    const res = await request(app.getHttpServer()).get("/auth/callback");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("authentication_failed");
  });
});
