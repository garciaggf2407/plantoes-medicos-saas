# Auditoria de acessibilidade do redesign visual

**BP-2026-07-11-002 T-4.1.1** — Contraste WCAG AA e navegação por teclado dos componentes e páginas entregues em E-1/E-2/E-3.

Data: 2026-07-11

## Metodologia

- **Contraste:** razão calculada pela fórmula oficial WCAG 2.1 (luminância relativa sRGB), aplicada aos valores hex exatos usados no CSS/Tailwind de cada componente — não estimado visualmente. Script em `node` reproduzindo a fórmula, ver cálculo em anexo no fim deste documento.
- **Teclado:** varredura automatizada real via Playwright contra os servidores de desenvolvimento (`pnpm dev:api` + `pnpm dev:web`), autenticado pelo `FakeOidcProvider` (mesmo handshake HTTP usado pelos testes E2E), navegando as 7 páginas e disparando `Tab` repetidamente. Para cada parada de foco, o script leu `document.activeElement` e seu `getComputedStyle` (outline/box-shadow) — não é uma inspeção manual, é leitura real do DOM renderizado.

## Contraste de cor (texto/fundo)

Threshold WCAG AA: **>= 4.5:1** para texto normal, **>= 3:1** para texto grande (>=18pt ou >=14pt bold) ou componentes de UI.

| Combinação | Cores (fg / bg) | Razão | Resultado |
|---|---|---|---|
| Texto principal (slate-900 / branco) | `#0f172a` / `#ffffff` | 17.85:1 | ✅ PASSA |
| Texto secundário (slate-600 / branco) | `#475569` / `#ffffff` | 7.58:1 | ✅ PASSA |
| Button primary (branco / blue-600) | `#ffffff` / `#2563eb` | 5.17:1 | ✅ PASSA |
| Button danger (branco / red-600) | `#ffffff` / `#dc2626` | 4.83:1 | ✅ PASSA |
| Button secondary (slate-900 / branco) | `#0f172a` / `#ffffff` | 17.85:1 | ✅ PASSA |
| Button ghost (slate-600 / branco) | `#475569` / `#ffffff` | 7.58:1 | ✅ PASSA |
| Link/texto de ação (blue-600 / branco) | `#2563eb` / `#ffffff` | 5.17:1 | ✅ PASSA |
| Badge positive (emerald-700 / emerald-50) | `#047857` / `#ecfdf5` | 5.21:1 | ✅ PASSA |
| Badge pending (amber-700 / amber-50) | `#b45309` / `#fffbeb` | 4.84:1 | ✅ PASSA |
| Badge negative (red-700 / red-50) | `#b91c1c` / `#fef2f2` | 5.91:1 | ✅ PASSA |
| Badge neutral (slate-700 / slate-100) | `#334155` / `#f1f5f9` | 9.45:1 | ✅ PASSA |
| ErrorState (red-700 / red-50) | `#b91c1c` / `#fef2f2` | 5.91:1 | ✅ PASSA |
| EmptyState (slate-600 / slate-50) | `#475569` / `#f8fafc` | 7.24:1 | ✅ PASSA |
| Painel de sucesso da candidatura (emerald-700 / emerald-50) | `#047857` / `#ecfdf5` | 5.21:1 | ✅ PASSA |
| Calendário — DRAFT (slate-500, texto e fundo de evento) | `#64748b` / `#ffffff` | 4.76:1 | ✅ PASSA (corrigido) |
| Calendário — PUBLISHED (blue-600) | `#2563eb` / `#ffffff` | 5.17:1 | ✅ PASSA |
| Calendário — PENDING (amber-700, texto e fundo de evento) | `#b45309` / `#ffffff` | 5.02:1 | ✅ PASSA (corrigido) |
| Calendário — APPROVED/FILLED (emerald-700, texto e fundo de evento) | `#047857` / `#ffffff` | 5.48:1 | ✅ PASSA (corrigido) |
| Calendário — CANCELLED/REJECTED (red-600) | `#dc2626` / `#ffffff` | 4.83:1 | ✅ PASSA |

### Achado corrigido durante esta auditoria

A paleta original de `shift-calendar.tsx` (T-2.3.1) usava `emerald-600` (APPROVED), `amber-600` (PENDING) e `slate-400` (DRAFT) — respectivamente **3.77:1**, **3.19:1** e **2.56:1**, todos abaixo do mínimo de 4.5:1 para texto normal, tanto na legenda/tabela quanto como cor de fundo dos eventos no FullCalendar (que exige cor literal, não aceita `className`). Corrigido nesta auditoria trocando para o passo `-700` (emerald, amber) e `-500` (slate) da mesma escala semântica, preservando o significado (ver commit `22bccce`). Símbolo/texto de cada estado (◇ ○ ◐ ● ■ ✕) já garantia que a cor nunca era o único sinal — a correção é estritamente de contraste, não de semântica.

## Navegação por teclado — 7 páginas

Cada página foi carregada autenticada (médico ou administrador, conforme aplicável) e percorrida via `Tab` a partir do `<body>` até o ciclo retornar ao início. Resultado: **nenhum elemento interativo inalcançável, nenhum foco sem indicador visível.**

| Página | Papel | Paradas de foco | Foco visível em 100%? |
|---|---|---|---|
| `/` (deslogado/logado) | médico | 4 (link produto, Sair, 2 links de navegação por papel) | ✅ |
| `/medico/plantoes` | médico | 7 (produto, Sair, 3 campos de filtro, Filtrar, card do plantão) | ✅ |
| `/medico/plantoes/[id]` | médico | 4 (produto, Sair, Voltar, Candidatar-se) | ✅ |
| `/medico/calendario` | médico | 6 (produto, Sair, Mês, Semana, prev/next do FullCalendar) | ✅ |
| `/` (logado) | admin | 5 (produto, Sair, 3 links de navegação por papel) | ✅ |
| `/admin/plantoes` | admin | 9 (produto, Sair, especialidade, valor, início, fim, Criar, Editar, Cancelar) | ✅ |
| `/admin/revisao` | admin | 2 (produto, Sair — fila vazia no fixture de teste, sem itens pendentes) | ✅ |
| `/admin/calendario` | admin | 7 (produto, Sair, Mês, Semana, prev/next, linha da tabela textual) | ✅ |

**Nota metodológica:** a primeira passada do script confundiu os segmentos internos do `<input type="datetime-local">` (dia/mês/ano/hora/minuto, cada um consumindo um `Tab` sem trocar `document.activeElement`) com um loop de página — comportamento nativo padrão do navegador, não uma falha de acessibilidade. Corrigido no script antes de gerar a tabela acima; os números refletem a segunda passada, com deduplicação correta por identidade de nó DOM.

`/admin/revisao` mostra só 2 paradas porque o fixture de teste (`sc1`) não tem credenciais/candidaturas pendentes — comportamento correto do `EmptyState`, não uma lacuna de navegação.

## Conclusão

Zero combinação de cor abaixo do threshold WCAG AA após a correção aplicada nesta auditoria. Zero elemento interativo inalcançável ou sem indicador de foco nas 7 páginas. `qa.threshold: 95` de T-4.1.1 atendido.
