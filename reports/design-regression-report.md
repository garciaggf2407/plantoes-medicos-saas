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

Capturados via Playwright contra os servidores de desenvolvimento reais (não simulação/mockup), autenticado pelo `FakeOidcProvider` com o fixture `sc1` (mesmo mecanismo usado pelos testes E2E). Desktop = 1280x900, mobile = 375x812, `fullPage: true`.

| Página | Papel | Desktop | Mobile |
|---|---|---|---|
| `/` | médico | `reg-home-medico-desktop.png` | `reg-home-medico-mobile.png` |
| `/medico/plantoes` | médico | `reg-medico-plantoes-desktop.png` | `reg-medico-plantoes-mobile.png` |
| `/medico/plantoes/[id]` | médico | `reg-medico-plantao-detalhe-desktop.png` | `reg-medico-plantao-detalhe-mobile.png` |
| `/medico/calendario` | médico | `reg-medico-calendario-desktop.png` | `reg-medico-calendario-mobile.png` |
| `/admin/plantoes` | admin | `reg-admin-plantoes-desktop.png` | `reg-admin-plantoes-mobile.png` |
| `/admin/revisao` | admin | `reg-admin-revisao-desktop.png` | `reg-admin-revisao-mobile.png` |
| `/admin/calendario` | admin | `reg-admin-calendario-desktop.png` | `reg-admin-calendario-mobile.png` |

Revisão manual das 14 imagens: nenhuma quebra de layout. Cards empilham corretamente em 375px em todas as páginas com listas (plantões, revisão), tabelas com scroll horizontal contido no próprio container (`overflow-x-auto`) em `/admin/plantoes` e na lista textual do calendário, header persistente (`AppShell`) e `ActiveHospitalBanner` renderizam de forma consistente nas duas resoluções.

## Resultado

- **145/145 testes de API + 5/5 cenários E2E** — 100% verde.
- **14/14 screenshots sem quebra de layout visível.**
- Achado de contraste do calendário (ver `design-accessibility-audit.md`) corrigido antes deste relatório.

CP-4 satisfeito: zero regressão funcional, contraste WCAG AA confirmado, responsivo validado nas 7 páginas.
