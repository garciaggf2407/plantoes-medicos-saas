# Regressão: Permissões Multi-Cidade (BP-2026-07-13-001)

## Ambiente confirmado antes de rodar

- Redis local ativo (`redis-cli ping` → `PONG`), confirmado antes de cada rodada (PAT-002).
- Postgres local ativo, dados piloto (Campinas `c987110f-...`, Bauru `fc9f2d13-...`) confirmados intactos após todas as migrações desta execução (ver seção final).

## Testes de API (vitest)

**169 testes no total** (150 pré-existentes + 5 novos de E-2 `superadmin-cross-tenant-read.e2e-spec.ts` + 14 novos de E-3: 4 em `list-cities.e2e-spec.ts`, 7 em `search-shifts-by-city.e2e-spec.ts`, 3 adicionados a `credentials.e2e-spec.ts`).

**Cada arquivo, rodado isolado: 25/25 arquivos, 169/169 testes verdes**, incluindo `--pool=forks --poolOptions.forks.singleFork` (execução totalmente serial).

**Achado real durante a regressão**: rodadas da suíte COMPLETA (25 arquivos concorrentes) mostraram falhas intermitentes e não-determinísticas em 3 arquivos — `shift-commands.e2e-spec.ts`, `telemetry.e2e-spec.ts`, `email.e2e-spec.ts` — nenhum deles tocado por este blueprint (E-2/E-3 não editaram `shift-commands.service.ts`, `telemetry.ts` nem `email.adapter.ts`). Investigado por reprodução (PAT-001), não assumido:
- Cada um dos 3 arquivos passa 100% quando rodado isolado, repetidamente.
- O conjunto de arquivos que falha muda a cada rodada da suíte completa (não é sempre o mesmo teste) — assinatura de contenção de recursos (Postgres/Redis/CPU) entre ~25 instâncias Nest inicializando em paralelo neste ambiente, não um bug determinístico.
- `email.e2e-spec.ts` já tinha o mesmo padrão de flakiness documentado em **duas** execuções anteriores deste projeto (BP-2026-07-11-002 e BP-2026-07-12-001, ambas antes deste blueprint existir).

**Conclusão**: zero regressão real introduzida por este blueprint. A instabilidade é uma característica pré-existente do ambiente local sob carga concorrente, não das mudanças de E-2/E-3. Candidato a padrão para `pattern_library.yaml` em P6-LEARN (ver sugestão abaixo).

## Testes E2E (Playwright)

**11/11 verdes** (rodada completa, servidor único, sem concorrência de suíte):

| Arquivo | Cenários |
|---|---|
| `capture-screenshots.spec.ts` | 1 (evidência visual, pré-existente) |
| `hospital-profile.spec.ts` | 2 (pré-existente) |
| `permissoes-multi-cidade.spec.ts` | **3 novos** (SUPERADMIN só-leitura, médico troca de cidade, HOSPITAL_ADMIN bloqueado) |
| `success-criteria.spec.ts` | 5 (pré-existente, inclui SC-4 notificação) |

**Achado real durante a regressão (ambiente, não código)**: a primeira rodada da suíte E2E falhou em SC-4 (notificação in-app + email) por timeout. Causa raiz identificada por reprodução: o servidor de API que eu havia subido manualmente para verificação anterior não tinha `NOTIFICATIONS_WORKER_ENABLED=true` — só o `webServer` do próprio `playwright.config.ts` define essa variável ao subir a API, mas como já existia um servidor na porta 3001, o Playwright reaproveitou o meu (`reuseExistingServer: !process.env.CI`) em vez de subir um com a env correta. Corrigido reiniciando a API com a variável setada; SC-4 passou de forma consistente nas 2 rodadas seguintes.

## Build

- `pnpm --filter @plantoes/shared build`: limpo.
- `pnpm --filter @plantoes/api build`: limpo.
- `pnpm --filter @plantoes/web build`: limpo, 12 rotas geradas incluindo `/admin/superadmin`, `/admin/superadmin/[id]` e a busca de plantões atualizada.

## Dados piloto pós-migração

```json
[
  { "id": "c987110f-0a4f-467a-8531-f35d6534e129", "name": "Hospital Samaritano Unidade II", "city": "Campinas" },
  { "id": "fc9f2d13-8a6c-4275-b131-f20a07d2ad59", "name": "Hospital Bauru", "city": "Bauru" }
]
```

Ambos intactos após a migração `20260713142747_doctor_profile_city` e toda a execução deste blueprint.

## Sugestão para P6-LEARN

- **Novo padrão candidato**: "Suíte vitest completa neste ambiente local (Windows, ~25 arquivos Nest e2e-spec com Postgres+Redis reais) exibe flakiness por contenção de recursos quando rodada concorrente -- rodar arquivo-por-arquivo (ou `--pool=forks --poolOptions.forks.singleFork`) é o critério de verdade, não a rodada concorrente única." Complementar a PAT-002 (falso-positivo por infra parada) -- este é falso-positivo por infra sob contenção, não parada.
- Reforça **PAT-004** (paralelização de épicos independentes via subagentes): terceira confirmação empírica, agora com 2 subagentes reais em worktrees isoladas (E-2/E-3), incluindo a descoberta de que worktrees não veem mudanças não-commitadas da árvore principal -- exigiu reconciliação manual pós-merge (documentar como novo padrão/anti-padrão).
