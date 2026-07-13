import { test, expect } from "@playwright/test";
import { loginAs } from "./support/auth";
import { seedSc6, cleanup, type Sc6Fixture } from "./support/fixtures";

/**
 * BP-2026-07-13-001, T-4.1.1. Cada describe semeia e limpa seus
 * PRÓPRIOS dados (mesma disciplina de hospital-profile.spec.ts) --
 * nenhum cenário depende de outro nem da ordem de execução.
 */

test.describe("SUPERADMIN navega hospitais de cidades diferentes, só leitura", () => {
  let fixture: Sc6Fixture;

  test.beforeAll(() => {
    fixture = seedSc6();
  });

  test.afterAll(() => {
    cleanup("sc6");
  });

  test("lista os 2 hospitais e o detalhe não tem nenhum controle de edição", async ({ page, context, request }) => {
    await loginAs(context, request, fixture.superadminSubject, fixture.superadminEmail);

    await page.goto("/admin/superadmin");
    await expect(page.getByText(fixture.orgAName)).toBeVisible();
    await expect(page.getByText(fixture.orgBName)).toBeVisible();

    await page.getByText(fixture.orgAName).click();
    await expect(page).toHaveURL(new RegExp(`/admin/superadmin/${fixture.orgAId}`));
    await expect(page.getByText(fixture.cityA)).toBeVisible();

    // Asserção negativa explícita: leitura cross-tenant nunca vem com
    // via de edição -- nenhum <form> nem botão de salvar/aprovar/cancelar.
    await expect(page.locator("form")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /salvar|aprovar|cancelar|editar/i })).toHaveCount(0);
  });
});

test.describe("Médico sem cidade cadastrada escolhe e troca de cidade na busca", () => {
  let fixture: Sc6Fixture;

  test.beforeAll(() => {
    fixture = seedSc6();
  });

  test.afterAll(() => {
    cleanup("sc6");
  });

  test("pede escolha de cidade, mostra plantões de A, troca pra B e mostra plantões diferentes", async ({ page, context, request }) => {
    await loginAs(context, request, fixture.doctorSubject, fixture.doctorEmail);

    await page.goto("/medico/plantoes");
    await expect(page.getByText("Escolha uma cidade para ver os plantões disponíveis.")).toBeVisible();

    await page.getByLabel("Cidade").selectOption(fixture.cityA);
    await expect(page.getByText(`Plantões em ${fixture.cityA}.`)).toBeVisible();
    await expect(page.getByText("Clinica Geral")).toBeVisible();

    await page.getByLabel("Cidade").selectOption(fixture.cityB);
    await expect(page.getByText(`Plantões em ${fixture.cityB}.`)).toBeVisible();
    // Troca de cidade nunca é bloqueada -- nenhum aviso/erro de restrição.
    await expect(page.getByText(/não autorizado|bloqueado/i)).toHaveCount(0);
  });
});

test.describe("HOSPITAL_ADMIN é bloqueado em /admin/superadmin", () => {
  let fixture: Sc6Fixture;

  test.beforeAll(() => {
    fixture = seedSc6();
  });

  test.afterAll(() => {
    cleanup("sc6");
  });

  test("navegação direta à URL nunca retorna sucesso", async ({ page, context, request }) => {
    await loginAs(context, request, fixture.adminASubject, fixture.adminAEmail);

    await page.goto("/admin/superadmin");
    await expect(page.getByText(/não foi possível carregar os hospitais/i)).toBeVisible();
    await expect(page.getByText(fixture.orgBName)).toHaveCount(0);
  });
});
