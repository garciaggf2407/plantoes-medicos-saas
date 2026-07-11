import { test, expect } from "@playwright/test";
import { API_URL, addSessionCookie, cookieHeader, getSessionCookieValue, loginAs } from "./support/auth";
import {
  seedSc1,
  seedSc2,
  seedSc3,
  seedSc4,
  seedSc5,
  cleanup,
  checkNotification,
  checkEmailDelivery,
  type Sc1Fixture,
  type Sc2Fixture,
  type Sc3Fixture,
  type Sc4Fixture,
  type Sc5Fixture,
} from "./support/fixtures";

/**
 * SC-1..SC-5 de intent-spec.yaml, dirigidos contra a API e o web app
 * reais rodando localmente (ver playwright.config.ts), nunca
 * mockados. Cada describe semeia e limpa seus PRÓPRIOS dados
 * (prefixo e2e-<cenário>-, ver apps/api/scripts/e2e-fixtures.mjs) --
 * nenhum cenário depende de outro nem da ordem de execução.
 */

test.describe("SC-1: médico credenciado filtra, candidata-se e vê o plantão aprovado no calendário", () => {
  let fixture: Sc1Fixture;

  test.beforeAll(() => {
    fixture = seedSc1();
  });

  test.afterAll(() => {
    cleanup("sc1");
  });

  test("busca por especialidade, candidatura completa e aparece no calendário após aprovação", async ({ page, context, request }) => {
    await loginAs(context, request, fixture.doctorSubject, fixture.doctorEmail);

    await page.goto(`/medico/plantoes?organizationId=${fixture.orgId}&specialty=${fixture.specialty}`);
    const shiftLink = page.getByRole("link", { name: fixture.specialty });
    await expect(shiftLink).toBeVisible();

    await shiftLink.click();
    await expect(page).toHaveURL(new RegExp(`/medico/plantoes/${fixture.shiftId}`));

    await page.getByRole("button", { name: "Candidatar-se" }).click();
    await page.getByRole("button", { name: "Confirmar candidatura" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Candidatura enviada com sucesso" })).toBeVisible();

    // Aprovação pelo hospital: a UI de revisão em si é coberta pelo
    // SC-2; aqui só precisamos que a decisão aconteça para chegar ao
    // calendário aprovado, então é feita via API direta.
    const adminCookie = await getSessionCookieValue(request, fixture.adminSubject, fixture.adminEmail);
    const pendingRes = await request.get(`${API_URL}/applications/pending`, { headers: cookieHeader(adminCookie) });
    const pending = (await pendingRes.json()) as Array<{ id: string; doctorProfile: { user: { email: string } } }>;
    const application = pending.find((a) => a.doctorProfile.user.email === fixture.doctorEmail);
    expect(application).toBeTruthy();

    const reviewRes = await request.post(`${API_URL}/applications/${application!.id}/review`, {
      headers: cookieHeader(adminCookie),
      data: { organizationId: fixture.orgId, decision: "APPROVED", justification: "CRM e disponibilidade conferidos" },
    });
    expect(reviewRes.status()).toBe(201);

    await page.goto("/medico/calendario");
    await expect(page.getByText(`${fixture.specialty} — ${fixture.orgName}`)).toBeVisible();
  });
});

test.describe("SC-2: administrador publica plantão e aprova/rejeita candidatura", () => {
  let fixture: Sc2Fixture;

  test.beforeAll(() => {
    fixture = seedSc2();
  });

  test.afterAll(() => {
    cleanup("sc2");
  });

  test("publica dois plantões pela UI, aprova um e rejeita o outro", async ({ page, context, request }) => {
    await loginAs(context, request, fixture.adminSubject, fixture.adminEmail);
    await page.goto("/admin/plantoes");

    async function createAndPublish(startsAt: string, endsAt: string): Promise<void> {
      await page.getByLabel("Especialidade").fill(fixture.specialty);
      await page.getByLabel("Valor (R$)").fill("500");
      await page.getByLabel("Início").fill(startsAt);
      await page.getByLabel("Fim").fill(endsAt);
      await page.getByRole("button", { name: "Criar (rascunho)" }).click();
      const row = page.locator("tr", { hasText: fixture.specialty }).filter({ has: page.getByRole("button", { name: "Publicar" }) }).first();
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "Publicar" }).click();
    }

    await createAndPublish("2026-11-01T08:00", "2026-11-01T16:00");
    await createAndPublish("2026-11-02T08:00", "2026-11-02T16:00");

    const shiftsRes = await page.request.get(`${API_URL}/shifts`);
    const shifts = (await shiftsRes.json()) as Array<{ id: string; status: string; startsAt: string }>;
    const published = shifts.filter((s) => s.status === "PUBLISHED" && s.startsAt.startsWith("2026-11-0"));
    expect(published.length).toBeGreaterThanOrEqual(2);
    const [shiftToApprove, shiftToReject] = published;

    const doctorCookie = await getSessionCookieValue(request, fixture.doctorSubject, fixture.doctorEmail);
    const app1Res = await request.post(`${API_URL}/applications`, {
      headers: cookieHeader(doctorCookie),
      data: { shiftId: shiftToApprove!.id, organizationId: fixture.orgId },
    });
    expect(app1Res.status()).toBe(201);
    const app2Res = await request.post(`${API_URL}/applications`, {
      headers: cookieHeader(doctorCookie),
      data: { shiftId: shiftToReject!.id, organizationId: fixture.orgId },
    });
    expect(app2Res.status()).toBe(201);

    await page.goto("/admin/revisao");
    await expect(page.getByText(fixture.doctorEmail).first()).toBeVisible();

    // Duas candidaturas do mesmo médico aparecem na fila -- decide a
    // primeira (aprovar) e depois a que sobrar (rejeitar).
    const items = page.locator("li", { hasText: fixture.doctorEmail });
    await items.nth(0).getByPlaceholder("Justificativa (obrigatória)").fill("CRM conferido, aprovado");
    await items.nth(0).getByRole("button", { name: "Aprovar" }).click();
    await expect(page.getByText(fixture.doctorEmail)).toHaveCount(1);

    await page.getByPlaceholder("Justificativa (obrigatória)").fill("Documentação incompleta");
    await page.getByRole("button", { name: "Rejeitar" }).click();
    await expect(page.getByText(fixture.doctorEmail)).toHaveCount(0);

    const adminCookie = await getSessionCookieValue(request, fixture.adminSubject, fixture.adminEmail);
    const finalShiftsRes = await request.get(`${API_URL}/shifts`, { headers: cookieHeader(adminCookie) });
    const finalShifts = (await finalShiftsRes.json()) as Array<{ id: string; status: string }>;
    expect(finalShifts.find((s) => s.id === shiftToApprove!.id)?.status).toBe("FILLED");
    expect(finalShifts.find((s) => s.id === shiftToReject!.id)?.status).toBe("PUBLISHED");
  });
});

test.describe("SC-3: acesso cross-hospital é bloqueado", () => {
  let fixture: Sc3Fixture;

  test.beforeAll(() => {
    fixture = seedSc3();
  });

  test.afterAll(() => {
    cleanup("sc3");
  });

  test("admin de outro hospital não vê nem consegue escrever no plantão de org-A", async ({ page, context, request }) => {
    await loginAs(context, request, fixture.adminBSubject, fixture.adminBEmail);

    await page.goto("/admin/plantoes");
    await expect(page.getByText("Neurologia")).toHaveCount(0);

    const publishRes = await page.request.post(`${API_URL}/shifts/${fixture.shiftIdInOrgA}/publish`);
    expect([403, 404]).toContain(publishRes.status());

    const cancelRes = await page.request.post(`${API_URL}/shifts/${fixture.shiftIdInOrgA}/cancel`);
    expect([403, 404]).toContain(cancelRes.status());
  });
});

test.describe("SC-4: notificação de plantão compatível chega para médicos elegíveis (in-app e email)", () => {
  let fixture: Sc4Fixture;

  test.beforeAll(() => {
    fixture = seedSc4();
  });

  test.afterAll(() => {
    cleanup("sc4");
  });

  test("publicar um plantão compatível cria notificação in-app e confirma entrega de email", async ({ page, context, request }) => {
    await loginAs(context, request, fixture.adminSubject, fixture.adminEmail);
    await page.goto("/admin/plantoes");

    await page.getByLabel("Especialidade").fill(fixture.specialty);
    await page.getByLabel("Valor (R$)").fill("600");
    await page.getByLabel("Início").fill("2026-11-10T08:00");
    await page.getByLabel("Fim").fill("2026-11-10T16:00");
    await page.getByRole("button", { name: "Criar (rascunho)" }).click();
    // Único plantão nesta org isolada -- localizado só pela
    // especialidade (sem filtrar por "Publicar" continuar presente,
    // que deixa de existir assim que o status muda para PUBLISHED e
    // tornaria este mesmo locator "invisível" depois do clique).
    const row = page.locator("tr", { hasText: fixture.specialty }).first();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Publicar" }).click();
    await expect(row.getByText("Publicado")).toBeVisible();

    const doctorCookie = await getSessionCookieValue(request, fixture.doctorSubject, fixture.doctorEmail);

    await expect(async () => {
      const notificationsRes = await request.get(`${API_URL}/notifications`, { headers: cookieHeader(doctorCookie) });
      const body = (await notificationsRes.json()) as { items: Array<{ type: string; payload: { specialty?: string } }> };
      const found = body.items.some((n) => n.type === "shift.published" && n.payload.specialty === fixture.specialty);
      expect(found).toBe(true);
    }).toPass({ timeout: 15_000, intervals: [500, 1000] });

    await expect(async () => {
      const result = checkEmailDelivery(fixture.orgId, fixture.doctorUserId);
      expect(result.found).toBe(true);
    }).toPass({ timeout: 15_000, intervals: [500, 1000] });
  });
});

test.describe("SC-5: dupla aprovação do mesmo plantão é impossível sob concorrência", () => {
  let fixture: Sc5Fixture;

  test.beforeAll(() => {
    fixture = seedSc5();
  });

  test.afterAll(() => {
    cleanup("sc5");
  });

  test("duas aprovações concorrentes para o mesmo plantão -- só uma vence", async ({ request }) => {
    const adminCookie = await getSessionCookieValue(request, fixture.adminSubject, fixture.adminEmail);

    const [res1, res2] = await Promise.all([
      request.post(`${API_URL}/applications/${fixture.application1Id}/review`, {
        headers: cookieHeader(adminCookie),
        data: { organizationId: fixture.orgId, decision: "APPROVED", justification: "Aprovando candidato 1" },
      }),
      request.post(`${API_URL}/applications/${fixture.application2Id}/review`, {
        headers: cookieHeader(adminCookie),
        data: { organizationId: fixture.orgId, decision: "APPROVED", justification: "Aprovando candidato 2" },
      }),
    ]);

    const statuses = [res1.status(), res2.status()];
    const successCount = statuses.filter((s) => s >= 200 && s < 300).length;
    expect(successCount).toBe(1);
    const loserStatus = statuses.find((s) => !(s >= 200 && s < 300))!;
    expect([400, 409]).toContain(loserStatus);

    const shiftsRes = await request.get(`${API_URL}/shifts`, { headers: cookieHeader(adminCookie) });
    const shifts = (await shiftsRes.json()) as Array<{ id: string; status: string }>;
    const shift = shifts.find((s) => s.id === fixture.shiftId);
    expect(shift?.status).toBe("FILLED");
  });
});
