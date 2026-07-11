# Runbooks Operacionais

**Escopo:** apps/api (NestJS), apps/web (Next.js), worker de notificações (mesmo processo do
apps/api, ver `NotificationWorkerService`), PostgreSQL 16, Redis (BullMQ).
**Pré-requisito de leitura:** `reports/security-baseline.md` (postura de segurança atual),
`infra/docker-compose.yml` (T-5.3.2, deploy reproduzível).
**Convenção:** todo comando marcado ⚠️ **DESTRUTIVO** exige que quem executa leia a descrição
completa e digite a confirmação pedida antes de rodar — nunca copiar e colar sem ler.
**Contatos de escalonamento:** os runbooks abaixo usam placeholders explícitos como
`<responsável-oncall>`, `<canal-de-incidente>` — preencher com os valores reais da organização
antes do primeiro deploy em produção. Nenhum contato real está hardcoded aqui de propósito.

---

## 1. Deploy

**Gatilho:** nova versão aprovada em `main`, pronta para ir ao ar (ver checkpoint CP-5).

**Passos:**

1. Confirmar que a suíte de testes está verde na versão a implantar:
   ```
   pnpm test          # apps/api (Vitest, Postgres real)
   pnpm build         # build completo do workspace
   ```
2. Confirmar que o E2E dos 5 critérios de sucesso está verde (ver T-5.2.1):
   ```
   pnpm --filter @plantoes/web exec playwright test
   ```
3. Definir as variáveis de ambiente de produção (nunca reaproveitar os valores de
   `.env`/`.env.local` de desenvolvimento — todos são placeholders de dev local):
   - `DATABASE_URL` (role restrita `plantoes_app`, nunca a role de migração/superusuário)
   - `SESSION_SECRET` (≥32 caracteres aleatórios, único por ambiente — nunca reaproveitar entre
     dev/staging/produção)
   - `COOKIE_SECURE=true` (produção sempre roda atrás de HTTPS)
   - `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` (provedor
     real — sem esses valores, a aplicação usa o `FakeOidcProvider`, que **nunca** deve rodar em
     produção; ver seção 5 abaixo)
   - `REDIS_URL`, `NOTIFICATIONS_WORKER_ENABLED=true`
   - `EMAIL_PROVIDER` (trocar de `console` para um provider real assim que uma conta de envio de
     email existir — ver `apps/api/src/notifications/email.adapter.ts`)
   - `OTEL_EXPORTER_OTLP_ENDPOINT` (opcional — sem ele, traces/métricas vão só para o console do
     processo, ver T-5.2.2)
4. Preencher `infra/.env` a partir de `infra/.env.example` (nunca reaproveitar `infra/.env` de
   outro ambiente — `POSTGRES_SUPERUSER_PASSWORD`, `PLANTOES_APP_DB_PASSWORD` e `SESSION_SECRET`
   devem ser únicos por ambiente).
5. Subir os serviços via `infra/docker-compose.yml` (T-5.3.2) — um único comando:
   ```
   docker compose -f infra/docker-compose.yml --env-file infra/.env up -d
   ```
   O serviço one-off `migrate` roda as migrations do Prisma com a role de MIGRAÇÃO (superusuário,
   nunca a role de runtime `plantoes_app`) e define a senha da role de runtime automaticamente,
   ANTES dos serviços `api`/`worker` subirem (`depends_on: condition: service_completed_successfully`
   — não é preciso rodar `prisma migrate deploy` manualmente à parte).
6. Aguardar os healthchecks (`GET /health` no apps/api/worker, resposta HTTP <500 do apps/web)
   ficarem `healthy` (`docker compose -f infra/docker-compose.yml ps`) antes de rotear tráfego
   real para a nova versão.

**Critério de validação:** `GET /health` retorna `200 {"status":"ok"}`; login de um usuário de
teste conhecido funciona ponta a ponta; `docker compose ps` mostra todos os serviços como
`healthy`.

---

## 2. Rollback

**Gatilho:** erro crítico detectado logo após um deploy (ex.: taxa de erro 5xx elevada, falha em
`/health`, regressão funcional grave reportada).

**Princípio de design que torna isto seguro:** rollback de aplicação **nunca** exige rollback de
schema (ver critério de aceite de T-5.3.2). Migrations do Prisma neste projeto seguem o padrão
"expandir antes de contrair" — uma coluna nova é sempre `NULL`-ável ou tem `DEFAULT` na mesma
migration que a introduz, então uma versão anterior da aplicação continua funcionando contra um
schema mais novo sem quebrar.

**Passos:**

1. Identificar a última tag/imagem estável anterior ao deploy problemático:
   ```
   git log --oneline -10
   docker images | grep plantoes
   ```
2. ⚠️ **DESTRUTIVO (interrompe o serviço por alguns segundos)** — confirme antes de continuar:
   substituir a imagem em produção pela tag anterior (`infra/scripts/rollback-app.sh` só troca a
   imagem e reinicia os serviços — **nunca** roda o serviço `migrate`/toca o schema):
   ```
   sh infra/scripts/rollback-app.sh <tag-anterior-conhecida-boa>
   ```
   Equivalente manual, se preferir rodar passo a passo:
   ```
   docker compose -f infra/docker-compose.yml down
   PLANTOES_IMAGE_TAG=<tag-anterior-conhecida-boa> docker compose -f infra/docker-compose.yml up -d
   ```
3. **Nunca** rodar `prisma migrate reset` nem reverter uma migration já aplicada como parte de
   um rollback de aplicação — isso é uma operação de schema, tratada separadamente (e é rara,
   já que o padrão expandir-antes-de-contrair evita a necessidade na maioria dos incidentes).
4. Confirmar no `.planning`/canal de incidente que o rollback foi feito e por quê.

**Critério de validação:** `GET /health` volta a `200`; taxa de erro 5xx volta ao nível normal;
o fluxo que causou o incidente é reproduzido manualmente na versão anterior e **não** ocorre.

---

## 3. Backup e Restore

**Gatilho (backup):** rotina agendada (recomendado: diário, fora do horário de pico) — não é um
procedimento de incidente, é preventivo.
**Gatilho (restore):** perda de dados confirmada, corrupção de banco, ou necessidade de
recuperar um estado anterior para investigação.

**O que precisa de backup:** só o PostgreSQL. O Redis, neste sistema, guarda apenas o estado
*em trânsito* das filas do BullMQ (jobs `PENDING`/`PROCESSING` no worker de notificações) — a
fonte de verdade é a tabela `outbox_events` no Postgres (ver T-5.1.1). Se o Redis for perdido
por completo, nenhum dado de negócio é perdido: todo evento ainda `PENDING` no Postgres volta a
ser processado assim que o worker reconectar e `pollOnce()` rodar de novo. **Não é necessário
fazer backup do Redis.**

### 3a. Backup

```
pg_dump --format=custom --file="backup-$(date +%Y%m%d-%H%M%S).dump" "$DATABASE_URL_SUPERUSER"
```

Armazenar o arquivo `.dump` fora da mesma máquina/volume do banco (ex.: bucket de object storage
com retenção configurada — `<endpoint-de-storage-de-backup>` é um placeholder, preencher com o
destino real). Validar periodicamente que o backup mais recente é restaurável (seção 3b, contra
um banco de teste descartável).

### 3b. Restore

⚠️ **DESTRUTIVO (sobrescreve o banco de destino por completo)** — nunca rodar contra o banco de
produção sem confirmação explícita de uma segunda pessoa. Digite mentalmente "isto vai apagar
todos os dados atuais do banco de destino" antes de prosseguir.

```
# 1. Confirmar que o destino é o banco correto (nunca produção por engano):
psql "$DATABASE_URL_SUPERUSER" -c "SELECT current_database();"

# 2. Restaurar (recria o schema a partir do dump, substituindo o que existir):
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL_SUPERUSER" backup-XXXXXXXX.dump

# 3. Re-conceder os privilégios da role de runtime (pg_restore com --clean não preserva GRANTs
#    customizados feitos fora do schema padrão do Prisma -- ver migrations
#    app_role_grants/audit_log_immutable/outbox_events/email_delivery):
pnpm --filter @plantoes/api exec prisma migrate deploy
```

**Critério de validação:** `SELECT count(*) FROM organizations;` (e outras tabelas centrais)
retorna os números esperados do momento do backup; login e um fluxo core (busca de plantão)
funcionam contra o banco restaurado; a role `plantoes_app` consegue autenticar e operar
normalmente (RLS + GRANTs intactos).

---

## 4. Fila de notificação travada

**Gatilho:** alertas de `plantoes.notification_delivery.count` (métrica, ver T-5.2.2) pararam de
crescer apesar de haver atividade de negócio; ou usuários reportando não receber notificações
esperadas (SC-4).

**Diagnóstico:**

1. Confirmar que o worker está rodando e conectado ao Redis:
   ```
   redis-cli -u "$REDIS_URL" ping     # deve responder PONG
   ```
   Se não responder: Redis caiu ou é inacessível — reiniciar o serviço de Redis primeiro; o
   worker não processa nada sem ele (ver `NotificationWorkerService.start()`).
2. Verificar eventos pendentes há muito tempo (indica poll não está rodando, ou
   `NOTIFICATIONS_WORKER_ENABLED` não está `true` neste ambiente):
   ```sql
   SELECT id, organization_id, event_type, status, attempts, available_at, created_at
   FROM outbox_events
   WHERE status = 'PENDING' AND created_at < now() - interval '5 minutes'
   ORDER BY created_at ASC
   LIMIT 20;
   ```
3. Verificar eventos presos em `PROCESSING` por muito tempo — indica que um worker morreu no
   meio do processamento de um job (crash, OOM, deploy sem graceful shutdown) e nunca liberou a
   linha de volta. **Isto é uma lacuna conhecida do desenho atual**: não existe hoje um
   mecanismo automático de "reclaim" de linhas presas em `PROCESSING` (ver
   `apps/api/src/notifications/notification.worker.ts`, método `claimBatch` — só reivindica
   linhas `PENDING`, nunca `PROCESSING` órfãs).
   ```sql
   SELECT id, organization_id, event_type, status, attempts, updated_at
   FROM outbox_events
   WHERE status = 'PROCESSING' AND updated_at < now() - interval '10 minutes'
   ORDER BY updated_at ASC;
   ```
4. Verificar dead-letters (eventos que esgotaram as tentativas — ver `OutboxService.listDeadLetter`):
   ```sql
   SELECT id, organization_id, event_type, attempts, last_error, updated_at
   FROM outbox_events
   WHERE status = 'DEAD_LETTER'
   ORDER BY updated_at DESC
   LIMIT 20;
   ```

**Remediação:**

- Para linhas presas em `PROCESSING` órfãs (passo 3): ⚠️ **DESTRUTIVO PARA O ESTADO DA FILA**
  (força reprocessamento — só é seguro porque cada handler é idempotente por desenho, ver
  T-5.1.3/T-5.1.4). Confirme que o worker que travou realmente está morto (não é só lento) antes
  de rodar:
  ```sql
  UPDATE outbox_events
  SET status = 'PENDING', available_at = now()
  WHERE status = 'PROCESSING' AND updated_at < now() - interval '10 minutes';
  ```
  Depois, reiniciar o worker (ou aguardar o próximo ciclo de poll, `NOTIFICATIONS_POLL_INTERVAL_MS`)
  para que `pollOnce()` reivindique essas linhas de novo.
- Para dead-letters (passo 4): investigar `last_error` de cada linha. Se o erro raiz já foi
  corrigido (ex.: bug no handler, já resolvido em deploy posterior), reenfileirar manualmente:
  ```sql
  UPDATE outbox_events
  SET status = 'PENDING', attempts = 0, available_at = now(), last_error = NULL
  WHERE id = '<id-do-evento>';
  ```
- Se o Redis foi perdido por completo (ver seção 3): não é necessário nenhum passo manual além
  de garantir que o worker reconecta — todo evento ainda `PENDING`/`PROCESSING` no Postgres será
  naturalmente reivindicado nos próximos ciclos de poll.

**Critério de validação:** `plantoes.notification_delivery.count` volta a crescer;
`SELECT count(*) FROM outbox_events WHERE status = 'PENDING' AND created_at < now() - interval '5 minutes'`
retorna 0 (ou próximo disso, dentro do intervalo normal de poll).

---

## 5. Indisponibilidade do provedor OIDC

**Gatilho:** provedor OIDC externo fora do ar ou instável (timeouts, 5xx nas chamadas de
`/auth/login` e `/auth/callback`).

**Impacto real (não hipotético — ver `AuthService`/`SessionService`):** a sessão desta
aplicação é um cookie **assinado localmente por HMAC** (`plantoes_session`), verificado sem
nenhuma chamada de rede ao provedor a cada requisição (`SessionService.verify`, puramente
local). Isso significa que **sessões já ativas continuam funcionando normalmente** durante uma
indisponibilidade do provedor — só **login novo** (fluxo `/auth/login` → `/auth/callback`) fica
indisponível, porque `AuthService.startLogin`/`handleCallback` dependem do provedor para o
handshake OIDC.

**Passos:**

1. Confirmar o escopo real do impacto: tentar `/auth/login` manualmente e observar se o
   redirecionamento para o provedor falha ou demora.
2. Verificar o status do provedor (página de status do provedor, se pública — `<url-de-status-do-provedor>`
   é um placeholder, preencher com o endereço real do provedor OIDC contratado).
3. Comunicar no `<canal-de-incidente>`: "login novo indisponível, sessões já ativas não são
   afetadas" — isso muda a severidade percebida do incidente (não é uma parada total).
4. Se a indisponibilidade for prolongada (>30 min) e houver acordo de nível de serviço com
   usuários, considerar aviso no portal (banner) informando o problema — não há mecanismo
   automático de banner nesta versão do produto; é uma comunicação manual.
5. Quando o provedor voltar: validar `/auth/login` → `/auth/callback` manualmente com uma conta
   de teste antes de declarar o incidente resolvido.

**Escalonamento:** se a indisponibilidade persistir além de `<tempo-limite-de-escalonamento>`,
acionar `<responsável-oncall>` do time de identidade/plataforma via `<canal-de-incidente>`.

**Critério de validação:** login novo funciona ponta a ponta com uma conta de teste; nenhuma
sessão ativa foi derrubada durante o incidente (verificável comparando contagem de sessões
ativas — aproximada, via taxa de requisições autenticadas — antes/depois).
