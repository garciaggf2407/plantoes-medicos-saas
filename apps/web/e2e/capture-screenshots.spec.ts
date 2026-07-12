import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { API_URL, cookieHeader, getSessionCookieValue, loginAs } from "./support/auth";
import { seedSc1, cleanup, type Sc1Fixture } from "./support/fixtures";

/**
 * One-off capture script for the T-4.1.2 visual-redesign evidence
 * (reports/design-regression-report.md). The 14 screenshots the report
 * originally referenced were never actually produced/committed -- this
 * re-captures them for real against the real dev servers (see
 * playwright.config.ts webServer), reusing the same auth/fixture
 * helpers as success-criteria.spec.ts.
 *
 * Reuses seedSc1() (approved doctor + admin + org + one PUBLISHED
 * shift) as the base, then layers on top via direct API calls (not
 * UI) the minimum extra state needed so all 7 routes render real
 * content instead of empty states:
 *   - fixture.shiftId: doctor applies + admin approves -> FILLED,
 *     appears on /medico/calendario.
 *   - shift2 (PUBLISHED, never applied to): stays visible to the
 *     search/getById endpoints (which only return PUBLISHED shifts),
 *     used for /medico/plantoes listing + /medico/plantoes/[id] detail.
 *   - shift3 (PUBLISHED): doctor applies but admin never decides ->
 *     PENDING application, used for /admin/revisao.
 */

const OUT_DIR = path.resolve(__dirname, "../../../reports/screenshots");
const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 375, height: 812 };

test.describe("Capture design-regression screenshots (T-4.1.2 evidence)", () => {
  let fixture: Sc1Fixture;

  test.beforeAll(() => {
    fixture = seedSc1();
  });

  test.afterAll(() => {
    cleanup("sc1");
  });

  test("captures desktop + mobile screenshots for all 7 reviewed routes", async ({ page, context, request }) => {
    test.setTimeout(180_000);
    fs.mkdirSync(OUT_DIR, { recursive: true });

    async function capture(url: string, baseName: string): Promise<void> {
      await page.setViewportSize(DESKTOP);
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      await page.screenshot({ path: path.join(OUT_DIR, `${baseName}-desktop.png`), fullPage: true });

      await page.setViewportSize(MOBILE);
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      await page.screenshot({ path: path.join(OUT_DIR, `${baseName}-mobile.png`), fullPage: true });
    }

    const adminCookie = await getSessionCookieValue(request, fixture.adminSubject, fixture.adminEmail);
    const doctorCookie = await getSessionCookieValue(request, fixture.doctorSubject, fixture.doctorEmail);

    // fixture.shiftId: doctor applies, admin approves -> FILLED, shows up approved on /medico/calendario.
    const app1Res = await request.post(`${API_URL}/applications`, {
      headers: cookieHeader(doctorCookie),
      data: { shiftId: fixture.shiftId, organizationId: fixture.orgId },
    });
    const app1 = (await app1Res.json()) as { id: string };
    await request.post(`${API_URL}/applications/${app1.id}/review`, {
      headers: cookieHeader(adminCookie),
      data: { organizationId: fixture.orgId, decision: "APPROVED", justification: "CRM e disponibilidade conferidos" },
    });

    // shift2: extra PUBLISHED shift, left unapplied -- used for the doctor listing + detail pages
    // (getPublishedById only returns PUBLISHED shifts, so this must never be applied to/decided).
    const shift2Res = await request.post(`${API_URL}/shifts`, {
      headers: cookieHeader(adminCookie),
      data: { specialty: fixture.specialty, valueCents: 75000, startsAt: "2026-10-05T08:00:00Z", endsAt: "2026-10-05T16:00:00Z" },
    });
    const shift2 = (await shift2Res.json()) as { id: string };
    await request.post(`${API_URL}/shifts/${shift2.id}/publish`, { headers: cookieHeader(adminCookie) });

    // shift3: PUBLISHED, doctor applies but admin never reviews -> PENDING application for /admin/revisao.
    const shift3Res = await request.post(`${API_URL}/shifts`, {
      headers: cookieHeader(adminCookie),
      data: { specialty: fixture.specialty, valueCents: 68000, startsAt: "2026-10-10T08:00:00Z", endsAt: "2026-10-10T16:00:00Z" },
    });
    const shift3 = (await shift3Res.json()) as { id: string };
    await request.post(`${API_URL}/shifts/${shift3.id}/publish`, { headers: cookieHeader(adminCookie) });
    await request.post(`${API_URL}/applications`, {
      headers: cookieHeader(doctorCookie),
      data: { shiftId: shift3.id, organizationId: fixture.orgId },
    });

    // --- doctor-facing pages ---
    await loginAs(context, request, fixture.doctorSubject, fixture.doctorEmail);
    await capture("/", "reg-home-medico");
    await capture(`/medico/plantoes?organizationId=${fixture.orgId}`, "reg-medico-plantoes");
    await capture(`/medico/plantoes/${shift2.id}?organizationId=${fixture.orgId}`, "reg-medico-plantao-detalhe");
    await capture("/medico/calendario", "reg-medico-calendario");

    // --- admin-facing pages ---
    await loginAs(context, request, fixture.adminSubject, fixture.adminEmail);
    await capture("/admin/plantoes", "reg-admin-plantoes");
    await capture("/admin/revisao", "reg-admin-revisao");
    await capture("/admin/calendario", "reg-admin-calendario");
  });
});
