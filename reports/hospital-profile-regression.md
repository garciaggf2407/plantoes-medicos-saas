# Regressão completa — Perfil do Hospital

**BP-2026-07-12-001 T-4.1.2** — Fecha CP-4 (QA e regressão) do incremento de perfil de hospital (cidade, endereço, descrição, foto).

Data: 2026-07-13

## Pré-condição verificada

`.tools/redis/redis-cli.exe ping` → `PONG` confirmado antes de cada rodada abaixo (ver `PAT-002` em `observability/pattern_library.yaml` — uma falha de teste com Redis fora do ar já foi confundida com regressão real neste projeto; não repetir esse erro).

## Suíte de testes

| Suíte | Resultado | Observação |
|---|---|---|
| `pnpm --filter @plantoes/api test` | **150/150 passando** | 22 arquivos (21 pré-existentes + `update-organization-profile.e2e-spec.ts`, T-1.2.3, 5 casos). Uma rodada anterior nesta mesma sessão reportou 148/150 (2 falhas em `email.e2e-spec.ts`); reexecutado o arquivo isolado duas vezes (4/5, depois 5/5) — confirmado timing flaky (mesma família de causa do PAT-002: teste depende de janela de polling do worker BullMQ), não regressão. Rodada final (usada para este relatório): 150/150 limpo. |
| `pnpm --filter @plantoes/web test:e2e` | **8/8 passando, rodada completa (sem --grep)** | 5 cenários pré-existentes (SC-1 a SC-5, blueprint BP-2026-07-11-002) + 2 novos (`hospital-profile.spec.ts`, T-4.1.1) + 1 script de captura de screenshots (`capture-screenshots.spec.ts`, não é um teste de regressão, gera evidência visual do redesign anterior). |

Nenhum teste foi pulado ou marcado como skip para forçar verde.

## Cenários novos (T-4.1.1)

1. **Edição reflete para o médico**: hospital_admin edita cidade/endereço/descrição em `/admin/hospital`, médico do mesmo hospital vê o bloco "Sobre o hospital" atualizado no detalhe do plantão.
2. **Isolamento cross-tenant**: hospital_admin de um segundo hospital (org-B) edita o próprio perfil; confirmado por leitura direta da API que o hospital original (org-A) permanece intacto — nenhum vazamento entre tenants.

## Cobertura de regressão real (não apenas "não quebrou")

- `search-shifts.query.ts` (T-2.1.1) alterado — os 150 testes de API incluem as suítes de `shifts/*` e `applications/*`, que exercitam `execute()`/`getPublishedById()` diretamente.
- SC-1 e SC-4 do blueprint anterior (candidatura completa; notificação de plantão compatível) rodados de fato, não só assumidos — confirmam que o novo card "Sobre o hospital" e o header dinâmico da listagem não interferem no fluxo de candidatura nem no worker de notificação.
- Isolamento cross-tenant verificado em 2 camadas independentes: API direta (T-1.2.3, supertest) e navegador real (T-4.1.1, Playwright).

## Resultado

- **150/150 testes de API + 8/8 cenários E2E (5 pré-existentes + 2 novos + 1 captura de evidência)** — 100% verde na rodada final.
- 1 falha isolada de timing em `email.e2e-spec.ts`, reproduzida e explicada (flaky, não regressão), não presente na rodada final usada para fechar este relatório.

CP-4 satisfeito: zero regressão funcional, isolamento cross-tenant verificado em duas camadas, feature completa ponta a ponta.
