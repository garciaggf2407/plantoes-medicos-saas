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
| E-5 Notificações e qualidade | IN PROGRESS | 2/9 |

## Current
- Epic: E-5 in progress (T-5.1.1 outbox transacional, T-5.1.2 worker de notificação done)
- Tests: 120/120 passing (apps/api), full workspace build green
- Frontend verificado em navegador real (Playwright) três vezes:
  E-3 (listagem->detalhe->candidatura, calendário mês/semana) e
  E-4 (gestão de plantões CRUD, fila de revisão, calendário da
  unidade — fluxo ponta a ponta confirmado: aprovar candidatura na
  fila fez o plantão aparecer como "Preenchido" no calendário)
- CP-3 e CP-4 ambas aprovadas → E-5 liberada
