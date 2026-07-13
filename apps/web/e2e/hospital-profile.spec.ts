import { test, expect } from "@playwright/test";
import { loginAs } from "./support/auth";
import { seedSc1, seedSc3, cleanup, type Sc1Fixture, type Sc3Fixture } from "./support/fixtures";

/**
 * BP-2026-07-12-001, T-4.1.1. Cada describe semeia e limpa seus
 * PRÓPRIOS dados (mesma disciplina de success-criteria.spec.ts) --
 * nenhum cenário depende de outro nem da ordem de execução.
 */

test.describe("Perfil do hospital: edição reflete para o médico", () => {
  let fixture: Sc1Fixture;

  test.beforeAll(() => {
    fixture = seedSc1();
  });

  test.afterAll(() => {
    cleanup("sc1");
  });

  test("hospital_admin edita perfil em /admin/hospital, médico vê a mudança no detalhe do plantão", async ({ page, context, request }) => {
    await loginAs(context, request, fixture.adminSubject, fixture.adminEmail);
    await page.goto("/admin/hospital");

    await page.getByLabel("Cidade").fill("Ribeirão Preto");
    await page.getByLabel("Endereço").fill("Av. Independência, 500");
    await page.getByLabel("Descrição").fill("Hospital de referência regional em cardiologia.");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("status").filter({ hasText: /salvo|sucesso|atualizado/i })).toBeVisible();

    await loginAs(context, request, fixture.doctorSubject, fixture.doctorEmail);
    await page.goto(`/medico/plantoes/${fixture.shiftId}?organizationId=${fixture.orgId}`);

    await expect(page.getByText("Sobre o hospital")).toBeVisible();
    await expect(page.getByText("Av. Independência, 500")).toBeVisible();
    await expect(page.getByText("Hospital de referência regional em cardiologia.")).toBeVisible();
  });
});

test.describe("Perfil do hospital: isolamento cross-tenant", () => {
  let fixture: Sc3Fixture;

  test.beforeAll(() => {
    fixture = seedSc3();
  });

  test.afterAll(() => {
    cleanup("sc3");
  });

  test("hospital_admin de ORG-B edita o próprio perfil e ORG-A permanece intacto", async ({ page, context, request }) => {
    // Estado inicial de org-A, para comparar depois -- nenhuma UI própria
    // necessária, GET /organizations/me já é escopado por sessão.
    await loginAs(context, request, fixture.adminASubject, fixture.adminAEmail);
    const beforeRes = await request.get(`${process.env.E2E_API_URL ?? "http://localhost:3001"}/organizations/me`, {
      headers: { Cookie: (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ") },
    });
    const orgABefore = await beforeRes.json();

    await loginAs(context, request, fixture.adminBSubject, fixture.adminBEmail);
    await page.goto("/admin/hospital");
    await page.getByLabel("Cidade").fill("Cidade de B — nunca deve aparecer em org-A");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("status").filter({ hasText: /salvo|sucesso|atualizado/i })).toBeVisible();

    await loginAs(context, request, fixture.adminASubject, fixture.adminAEmail);
    const afterRes = await request.get(`${process.env.E2E_API_URL ?? "http://localhost:3001"}/organizations/me`, {
      headers: { Cookie: (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ") },
    });
    const orgAAfter = await afterRes.json();

    expect(orgAAfter.city).toBe(orgABefore.city);
    expect(orgAAfter.city).not.toBe("Cidade de B — nunca deve aparecer em org-A");
  });
});
