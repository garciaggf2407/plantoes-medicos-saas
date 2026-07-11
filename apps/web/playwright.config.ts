import { defineConfig, devices } from "@playwright/test";

const API_PORT = 3001;
const WEB_PORT = 3000;

/**
 * T-5.2.1: E2E dos 5 critérios de sucesso (SC-1..SC-5, ver
 * outputs/blueprints/2026-07-10/plantoes-medicos-saas/intent-spec.yaml).
 * Sobe API + web reais contra o Postgres local de desenvolvimento
 * (nunca mockado) e o worker de notificações real (BullMQ + Redis --
 * ver globalSetup) para que SC-4 observe entrega de verdade, não uma
 * simulação.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @plantoes/api start:dev",
      // /auth/login redireciona (302) para http://fake-oidc.local/...
      // -- o cliente HTTP interno do webServer tenta seguir o
      // redirect e falha resolução de DNS repetidamente até estourar
      // o timeout. /health é público e responde 200 direto.
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      cwd: "../..",
      timeout: 120_000,
      env: {
        NOTIFICATIONS_WORKER_ENABLED: "true",
        NOTIFICATIONS_POLL_INTERVAL_MS: "500",
        NOTIFICATIONS_MAX_ATTEMPTS: "3",
        NOTIFICATIONS_BACKOFF_MS: "500",
        REDIS_URL: "redis://127.0.0.1:6379",
        EMAIL_PROVIDER: "console",
      },
    },
    {
      command: "pnpm --filter @plantoes/web dev",
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      cwd: "../..",
      timeout: 120_000,
    },
  ],
});
