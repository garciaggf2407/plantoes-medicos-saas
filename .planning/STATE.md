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
- Docker — ainda NÃO instalado neste ambiente (sem admin/UAC para o instalador do Docker
  Desktop, mesma limitação já documentada para Redis/gitleaks). `infra/docker-compose.yml` e os
  Dockerfiles (T-5.3.2) foram escritos e revisados com cuidado, mas o `docker compose up` em si
  **não pôde ser executado de verdade** — ver nota em T-5.3.2 abaixo sobre a verificação
  alternativa usada para compensar.

## Progress
| Epic | Status | Tasks Done |
|------|--------|------------|
| E-1 Fundação | APPROVED (CP-1, condicional — CI ainda não verificada) | 7/7 |
| E-2 Domínio core | APPROVED (CP-2) | 5/5 |
| E-3 Portal do Médico | APPROVED (CP-3) | 5/5 |
| E-4 Portal do Administrador | APPROVED (CP-4) | 4/4 |
| E-5 Notificações e qualidade | APPROVED (CP-5) | 9/9 |

## Blueprint
**BP-2026-07-10-002: COMPLETO.** Todos os 5 épicos aprovados (CP-1 a CP-5). CP-5 aprovado pelo
operador com ressalva reconhecida e aceita: deploy via Docker Compose (T-5.3.2) foi escrito e
verificado por meios alternativos (toolchain nativo), mas `docker compose up` real nunca rodou
neste ambiente (Docker não instalado, sem admin/UAC) — primeira execução real fica para a
primeira máquina com Docker disponível.

**Pendência remanescente (fora do escopo do blueprint, decisão do operador):** push para
`https://github.com/garciaggf2407/ProjetoMedicos.git` foi deliberadamente adiado ("vamos deixar
isso para o final") — `gh auth login` nunca foi concluído. Nada foi empurrado para o GitHub
ainda; o job Lint/CI nunca rodou de verdade em CI real (só localmente). Retomar quando o
operador decidir.

## Pós-blueprint: fixes adicionais
- `b48dc48` fix(security): FakeOidcProvider deixa de ser fallback silencioso quando
  `OIDC_ISSUER_URL` está vazia (default do próprio `infra/docker-compose.yml`) — boot agora falha
  fechado a menos que `ALLOW_FAKE_OIDC=true` seja setado explicitamente. Ajustado em conjunto:
  `apps/api/.env` (local) e `.env.example` (api e infra), `infra/docker-compose.yml` (passthrough
  para api/worker), `.github/workflows/ci.yml` (env no job de testes), `docs/operations/runbooks.md`
  seção 5. Verificado de verdade: boot sem a variável lança o erro esperado, boot com
  `ALLOW_FAKE_OIDC=true` sobe normalmente, 145/145 testes (Redis local ativo) + lint + typecheck +
  build completos, todos verdes.
- **Login clicável (dev) + 2 bugs reais encontrados navegando de verdade pela primeira vez.**
  Ninguém tinha aberto o app num navegador humano antes de hoje — os testes automatizados sempre
  injetam o cookie de sessão direto (ver STATE anterior), nunca seguem o redirect de login de
  verdade. Ao fazer isso pela primeira vez, apareceram 2 bugs reais:
  1. `/auth/login` redirecionava para `http://fake-oidc.local/authorize`, um domínio que nunca
     existiu — só funcionava no handshake HTTP puro dos testes, travava em qualquer navegador real.
     Corrigido: `FakeOidcProvider` agora aponta para `/auth/dev-login`, uma página local de verdade
     (`AuthService.renderDevLoginPage`/`buildDevLoginRedirect`, rotas em `auth.controller.ts`) —
     lista contas existentes (uma por papel) como links de um clique e um form para provisionar
     médico novo. 404 em qualquer request se `isFakeProviderActive()` for false — não depende de
     "essa rota não deveria estar acessível", checa a cada chamada.
  2. `/auth/callback` redirecionava para `"/"` relativo — em vez de cair na web app (porta 3000),
     caía na raiz da própria API (porta 3001). Corrigido: `OidcConfig.webOrigin` (de `WEB_ORIGIN`,
     mesmo default já usado no CORS) + `AuthService.getPostLoginRedirectUrl()`, usado tanto no
     callback quanto no logout (`FakeOidcProvider.getEndSessionUrl` também parava de apontar pro
     domínio morto — agora retorna `null`, honesto: o double não tem sessão de provedor pra encerrar).
  - `apps/web/app/page.tsx`: a home era literalmente o placeholder do `create-next-app`
    (`app/page.tsx` nunca editado) — sem link nenhum pro produto. Substituída por uma home real:
    estado deslogado (mensagem + botão Entrar), estado autenticado com navegação por papel
    (DOCTOR: Plantões disponíveis/Minha agenda; HOSPITAL_ADMIN: Gestão de plantões/Fila de
    revisão/Calendário da unidade; SUPERADMIN: nota de que só existe via API, sem tela ainda) e
    botão Sair.
  - Verificado clicando de verdade (Playwright, sem injetar cookie): home deslogada → clique em
    Entrar → página de dev-login real → clique numa conta existente → volta autenticado em
    `localhost:3000` → clique em "Plantões disponíveis" → navega pra `/medico/plantoes` de
    verdade. Zero erro de console (exceto o 401 esperado de `/me` na primeira checagem
    deslogada — ruído normal do navegador, não um bug). 145/145 testes + lint + typecheck
    continuam verdes.
  - **Gap conhecido, não corrigido hoje**: a busca de plantões do médico (`/medico/plantoes`)
    exige `organizationId` na URL e não há nenhum endpoint público para listar hospitais — um
    médico não tem como descobrir esse ID pela interface. A home linka pra lá mesmo assim; o link
    "funciona" mas a página mostra "Informe o hospital" sem explicar como. Decisão de escopo
    pendente do operador: busca cross-hospital vs. seletor de hospital.

## Current
- T-5.3.2 (infra/docker-compose.yml + infra/api.Dockerfile + infra/web.Dockerfile +
  infra/entrypoint-migrate.sh + infra/.env.example + infra/scripts/rollback-app.sh): serviços
  postgres, redis, migrate (one-off), api, worker (mesma imagem do api, `NOTIFICATIONS_WORKER_ENABLED=true`,
  serviço dedicado em vez de embutido no processo da api), web. `migrate` roda `prisma migrate
  deploy` com role privilegiada + `ALTER ROLE plantoes_app WITH PASSWORD ...` (a role de runtime
  nasce SEM senha por desenho — ver migration `app_role_grants` — fail-closed até um operador/o
  próprio deploy definir a senha), e só então `api`/`worker` sobem
  (`depends_on: condition: service_completed_successfully`) — é isso que faz "docker compose up"
  funcionar como um único comando numa máquina limpa. Nenhum segredo hardcoded no compose: todo
  valor sensível vem de `infra/.env` (gitignored, nunca committed) via `${VAR}` sem fallback.
  **Limitação honestamente declarada**: Docker não está instalado neste ambiente (sem
  admin/UAC), então `docker compose up` real nunca rodou aqui. Verificação alternativa feita de
  verdade, usando o toolchain nativo já instalado (não é uma simulação): (1) `pnpm --filter
  @plantoes/api build` + `node dist/main.js` — exatamente o CMD do container — rodou contra o
  Postgres local e respondeu `GET /health` → `200 {"status":"ok"}`, confirmando que o comando de
  runtime do Dockerfile funciona; (2) a substituição de senha via shell (`ALTER ROLE plantoes_app
  WITH PASSWORD '${VAR}'`) foi testada de verdade contra o Postgres local via psql, incluindo
  reautenticar como `plantoes_app` com a nova senha — funcionou; **descoberta real durante esse
  teste**: a sintaxe `:'var'` do psql (interpolação nativa do cliente, mais segura contra SQL
  injection que interpolação de shell) não substituiu a variável mesmo com `-v` — tentei consertar
  ordem dos argumentos (psql exige opções antes do argumento posicional de conexão) mas o erro de
  sintaxe persistiu; sem Docker para isolar se é um problema desta build específica do psql no
  Windows, adotei interpolação de shell simples no `entrypoint-migrate.sh` (documentada com a
  restrição de que a senha não pode conter apóstrofo). (3) `next build` com `output: "standalone"`
  falhou neste host Windows por EPERM ao criar symlinks (exige modo desenvolvedor/admin, indisponíveis
  aqui) — não consegui confirmar que funcionaria dentro do container Linux sem Docker para testar,
  então revertido para uma imagem mais simples e pesada (`pnpm install` completo + `next start`)
  em vez de arriscar um Dockerfile com um passo não verificável. **O que NÃO foi verificado**:
  `docker build`/`docker compose up` de ponta a ponta, healthchecks reais do compose, e o fluxo
  completo `migrate` → `api`/`worker` → `web` orquestrado pelo Docker propriamente dito. Se/quando
  Docker estiver disponível, rodar `docker compose -f infra/docker-compose.yml --env-file
  infra/.env up -d` e validar contra os critérios de aceite antes de considerar T-5.3.2
  definitivamente fechada em produção real.
- T-5.3.1 (docs/operations/runbooks.md): 5 runbooks (deploy, rollback, backup/restore, fila de
  notificação travada, indisponibilidade do provedor OIDC), cada um com gatilho/passos/critério
  de validação. Documenta honestamente uma lacuna real do desenho atual: não há reclaim
  automático de linhas outbox_events presas em PROCESSING (worker morto no meio de um job) —
  remediação manual descrita. Runbooks de Deploy/Rollback atualizados nesta task para referenciar
  o serviço `migrate` e `infra/scripts/rollback-app.sh` reais.
- T-5.2.3 (reports/security-baseline.md): SAST (ESLint + eslint-plugin-security), scan de
  dependências (pnpm audit) e scan de segredos (gitleaks) rodados de verdade, com evidência real
  anexada no relatório. Descoberta real: `apps/api` e `packages/shared` não tinham NENHUMA
  config de ESLint (pnpm lint falhava com "eslint não reconhecido") — nunca detectado porque CI
  nunca rodou de verdade (nada empurrado ainda). Corrigido: eslint.config.mjs criado para os
  dois + eslint-plugin-security adicionado também em apps/web. Achados: 1 regex triado como
  falso positivo (documentado inline + no relatório), 1 dependência moderada (postcss interno
  do Next.js, build-time only, aceite formal com expiração 2026-10-11), 0 segredos reais no
  histórico do git. Nenhum crítico/alto.
- Epic: E-5 in progress (S-5.1 completa: T-5.1.1-T-5.1.4; T-5.2.1 E2E; T-5.2.2 observabilidade)
- Tests: 138/138 passing (apps/api), 5/5 passing (Playwright E2E, apps/web), full workspace
  build green
- T-5.2.2 (apps/api/src/observability/telemetry.ts + structured-logger.ts): OpenTelemetry real
  (traces + métricas) para os 5 fluxos críticos (login, busca, candidatura, decisão, entrega de
  notificação) + log estruturado JSON correlacionado. Sem backend OTLP configurado neste
  ambiente (mesmo guardrail "double até CP-5"): exporta pro console por padrão;
  OTEL_EXPORTER_OTLP_ENDPOINT troca pra OTLP HTTP de verdade sem mudar chamador nenhum.
  Correlação ponta a ponta É REAL (não só um id copiado à mão): trace context W3C é
  injetado no payload do OutboxEvent no momento do enqueue e extraído pelo worker ao
  processar — o span "notification.deliver", criado num job assíncrono sem relação de
  call-stack com a requisição original, carrega o MESMO traceId do span "application.decide"
  que disparou o evento, confirmado por teste dedicado (test/observability/telemetry.e2e-spec.ts).
  **Bug real encontrado ao verificar (não um ajuste de teste)**: a API de métricas do
  OpenTelemetry (@opentelemetry/api 1.9.1) NÃO tem o mecanismo de proxy/delegate que a API de
  trace tem — `metrics.getMeter().createCounter(...)` chamado no import do módulo (antes de
  initTelemetry() rodar) vincula os counters PERMANENTEMENTE a um MeterProvider no-op; eles
  nunca registrariam nada de verdade, mesmo depois do provider real ser registrado. Corrigido
  criando os counters sob demanda (lazy, primeiro uso real dentro de um fluxo) em vez de no
  top-level do módulo. Lição: a API de trace e a de métricas do OpenTelemetry têm mecanismos de
  registro global DIFERENTES — não assumir que o padrão de uma se aplica à outra sem checar o
  código-fonte da versão instalada.
- Nota: testes que bootstram via Test.createTestingModule diretamente (todos exceto
  telemetry.e2e-spec.ts) NUNCA chamam initTelemetry() (main.ts não roda) — correlationId nos
  logs deles é null por design, não um bug. Só a app real (main.ts) e o teste dedicado
  registram um provider de verdade.
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
