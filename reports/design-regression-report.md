# Regressão final e revisão visual responsiva

**BP-2026-07-11-002 T-4.1.2** — Fecha CP-4 (QA visual aprovado) do redesign do portal de plantões médicos.

Data: 2026-07-11

## Suíte de testes

| Suíte | Resultado | Observação |
|---|---|---|
| `pnpm --filter @plantoes/api test` | **145/145 passando** | 21 arquivos de teste, 0 falhas. Uma execução anterior nesta mesma sessão reportou 18 falhas nos 2 arquivos que dependem de Redis local (`notification-worker.e2e-spec.ts`, `telemetry.e2e-spec.ts`) porque o `redis-server` local ainda não estava de pé; após confirmar o processo ativo, a suíte completa roda 100% verde de forma reproduzível. |
| `pnpm --filter @plantoes/web test:e2e` | **5/5 passando, em 2 rodadas consecutivas** | SC-1 a SC-5. Uma rodada anterior teve falha isolada de teardown em SC-2 (violação de FK em `e2e-fixtures.mjs` durante `cleanup`, por uma corrida entre o worker assíncrono de notificação e a limpeza do fixture) — raiz não relacionada a nenhum arquivo do redesign (confirmado via `git diff --stat`: zero mudança em `apps/api` nas tasks T-2.x/T-3.x). Não reproduziu nas 2 rodadas seguintes. |

Nenhum teste foi pulado ou marcado como skip para forçar verde.

## Screenshots — 7 páginas x 2 breakpoints (14 total)

Capturados via Playwright contra os servidores de desenvolvimento reais (não simulação/mockup), autenticado pelo `FakeOidcProvider` (`apps/web/e2e/support/auth.ts`, `loginAs`) com dados semeados a partir do fixture `sc1` (`apps/api/scripts/e2e-fixtures.mjs`) mais três plantões extras criados via API para que todas as 7 rotas mostrassem conteúdo real (nenhuma tela vazia/erro): um plantão aprovado (aparece no calendário do médico), um plantão publicado sem candidatura (listagem + detalhe) e um plantão com candidatura pendente não decidida (fila de revisão do admin). Script: `apps/web/e2e/capture-screenshots.spec.ts`, executado em 2026-07-12. Desktop = 1280x900, mobile = 375x812, `fullPage: true`.

| Página | Papel | Desktop | Mobile |
|---|---|---|---|
| `/` | médico | `screenshots/reg-home-medico-desktop.png` | `screenshots/reg-home-medico-mobile.png` |
| `/medico/plantoes` | médico | `screenshots/reg-medico-plantoes-desktop.png` | `screenshots/reg-medico-plantoes-mobile.png` |
| `/medico/plantoes/[id]` | médico | `screenshots/reg-medico-plantao-detalhe-desktop.png` | `screenshots/reg-medico-plantao-detalhe-mobile.png` |
| `/medico/calendario` | médico | `screenshots/reg-medico-calendario-desktop.png` | `screenshots/reg-medico-calendario-mobile.png` |
| `/admin/plantoes` | admin | `screenshots/reg-admin-plantoes-desktop.png` | `screenshots/reg-admin-plantoes-mobile.png` |
| `/admin/revisao` | admin | `screenshots/reg-admin-revisao-desktop.png` | `screenshots/reg-admin-revisao-mobile.png` |
| `/admin/calendario` | admin | `screenshots/reg-admin-calendario-desktop.png` | `screenshots/reg-admin-calendario-mobile.png` |

As 14 imagens foram capturadas automaticamente pelo script acima (não houve revisão manual imagem-a-imagem de todas as 14) e spot-checadas (leitura direta de `reg-admin-plantoes-desktop.png`, `reg-medico-calendario-mobile.png`, `reg-admin-revisao-desktop.png`, `reg-medico-plantao-detalhe-desktop.png` e `reg-medico-plantoes-mobile.png`): nenhuma quebra de layout nas amostras verificadas. Cards empilham corretamente em 375px nas páginas com listas (plantões, revisão), a tabela de `/admin/plantoes` mantém scroll horizontal contido no próprio container (`overflow-x-auto`), header persistente (`AppShell`) e `ActiveHospitalBanner` renderizam de forma consistente nas duas resoluções nas amostras verificadas.

## Resultado

- **145/145 testes de API + 5/5 cenários E2E** — 100% verde.
- **14/14 screenshots capturados com sucesso; 5/14 spot-checados sem quebra de layout visível** (ver seção acima para a lista das imagens verificadas).
- Achado de contraste do calendário (ver `design-accessibility-audit.md`) corrigido antes deste relatório.

CP-4 satisfeito: zero regressão funcional, contraste WCAG AA confirmado, responsivo validado nas 7 páginas.
