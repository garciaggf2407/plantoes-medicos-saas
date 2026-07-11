# STATE: BP-2026-07-10-002 — Plataforma de Gerenciamento de Plantões Médicos

## Config
- Mode: guided
- Blueprint: outputs/blueprints/2026-07-10/plantoes-medicos-saas/
- Target: projects/plantoes-medicos-saas
- Started: 2026-07-10

## Environment
- git 2.55.0.2 (D:\Git\cmd) — available, not on session PATH by default
- node 24.18.0 (D:\Node) — available, not on session PATH by default
- pnpm 11.11.0 — installed globally via npm
- PostgreSQL 16 — installed native via winget (Docker not installed; native used instead)
- Redis 5.0.14.1 (portable, no admin/MSI) — extracted to `projects/plantoes-medicos-saas/.tools/redis/`
  (gitignored). winget's `Redis.Redis` MSI needs UAC elevation unavailable in this
  non-interactive shell, so used tporadowski/redis's portable zip instead. Start with
  `.tools/redis/redis-server.exe .tools/redis/redis.windows.conf` (backgrounded); verify with
  `.tools/redis/redis-cli.exe ping`. Needed by NotificationWorkerService (BullMQ) — tests set
  `NOTIFICATIONS_WORKER_ENABLED` only per-test-instance, never globally, so Redis is only
  required when running `test/notifications/notification-worker.e2e-spec.ts`.
- GitHub CLI 2.96.0 (C:\Program Files\GitHub CLI, not on session PATH by default) — installed, NOT yet authenticated (user postponed `gh auth login`)
- GitHub remote: https://github.com/garciaggf2407/ProjetoMedicos.git (added as `origin`, branch `main`) — nothing pushed yet
- Docker — still NOT installed. Needed again for T-5.3.2 (docker-compose).

## Progress
| Epic | Status | Tasks Done |
|------|--------|------------|
| E-1 Fundação | APPROVED (CP-1, condicional — CI ainda não verificada) | 7/7 |
| E-2 Domínio core | APPROVED (CP-2) | 5/5 |
| E-3 Portal do Médico | APPROVED (CP-3) | 5/5 |
| E-4 Portal do Administrador | DONE (pending CP-4 approval) | 4/4 |
| E-5 Notificações e qualidade | IN PROGRESS | 5/9 |

## Current
- Epic: E-5 in progress (S-5.1 "Notificações confiáveis" completa: T-5.1.1-T-5.1.4;
  T-5.2.1 E2E dos 5 critérios de sucesso feito)
- Tests: 132/132 passing (apps/api), 5/5 passing (Playwright E2E, apps/web), full workspace
  build green
- T-5.2.1 (apps/web/e2e/success-criteria.spec.ts, apps/web/playwright.config.ts): sobe API+web
  reais + worker real (Redis) contra o Postgres de dev. Login sem UI (double de OIDC): drives
  GET /auth/login + /auth/callback via HTTP puro, injeta o cookie de sessão resultante no
  BrowserContext (apps/web/e2e/support/auth.ts). Seed/cleanup/verificação de efeitos sem UI
  própria (entrega de email) via apps/api/scripts/e2e-fixtures.mjs, que tem acesso direto ao
  Prisma (mesmo padrão de admin-prisma.ts da própria suíte da API) — dados tagueados
  e2e-<cenário>-, cleanup nunca depende de IDs de execuções anteriores.
  webServer readiness: NUNCA apontar para /auth/login (redireciona 302 para
  fake-oidc.local, que não resolve DNS — o client HTTP interno do Playwright tenta seguir e
  estoura timeout); usar /health.
- **Bug real encontrado pelo SC-5 (não simulado)**: duas aprovações concorrentes do mesmo
  plantão via chamadas HTTP paralelas de verdade (não supertest) revelaram um DEADLOCK real do
  Postgres (40P01) em ReviewApplicationUseCase — UPDATE em applications dispara ShareLock
  implícito na linha do shift referenciado (checagem de FK); as duas transações ficavam presas
  esperando uma a outra antes do UPDATE explícito em shifts, formando um ciclo. Antes só o P2002
  (constraint) era tratado; o deadlock vazava como 500. Corrigido com `SELECT ... FOR UPDATE`
  na linha do shift logo no início da transação, ANTES de qualquer UPDATE em applications —
  serializa decisões concorrentes do mesmo plantão em vez de deixá-las formar um ciclo de
  espera. Mantém a garantia (só uma aprovação, nunca duas) e a mesma superfície de erro
  ([400,409] no perdedor). Lição: testes de concorrência via requisições HTTP paralelas de
  verdade encontram classes de bug que Promise.all em supertest pode não reproduzir de forma
  confiável (timing de conexão diferente).
- Nota de arquitetura: NotificationWorkerService.registerHandler suporta múltiplos handlers por
  eventType (array, não 1:1) — InAppService (T-5.1.3) e EmailAdapter (T-5.1.4) reagem aos
  MESMOS eventos ("shift.published", "application.decided"). Handlers reutilizam o `tx` já
  aberto pelo processor para efeitos SEM impacto externo (in-app: rollback+retry é seguro,
  recria o mesmo estado). Descoberta real ao testar EmailAdapter: um email de verdade JÁ FOI
  enviado (efeito externo irreversível) antes do handler retornar — se um handler IRMÃO falhar
  depois, ctx.tx inteiro sofre rollback e apagaria a prova de entrega junto, causando reenvio
  real no retry. Corrigido: EmailAdapter.sendOnce usa sua PRÓPRIA transação
  (tenantContext.withTenantScope, não ctx.tx) para checar/gravar EmailDelivery — sobrevive ao
  rollback do job. Regra geral: efeitos com contraparte externa não reversível precisam de
  registro de confirmação em transação própria e já commitada; efeitos puramente internos ao
  banco podem viver dentro do tx compartilhado do job com segurança.
- Frontend verificado em navegador real (Playwright) três vezes:
  E-3 (listagem->detalhe->candidatura, calendário mês/semana) e
  E-4 (gestão de plantões CRUD, fila de revisão, calendário da
  unidade — fluxo ponta a ponta confirmado: aprovar candidatura na
  fila fez o plantão aparecer como "Preenchido" no calendário)
- CP-3 e CP-4 ambas aprovadas → E-5 liberada
