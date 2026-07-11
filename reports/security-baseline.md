# Baseline de Segurança — T-5.2.3

**Data:** 2026-07-11
**Escopo:** monorepo completo (`apps/api`, `apps/web`, `packages/shared`), HEAD do branch `main` neste momento.
**Responsável pela execução:** sessão de execução autônoma do blueprint (ATHENA OS).
**Método:** as três verificações rodaram localmente, com evidência anexada abaixo. Nenhum
resultado foi assumido ou estimado — todo achado listado veio da saída real da ferramenta.

---

## Resumo executivo

| Verificação | Ferramenta | Achados | Crítico/Alto sem correção |
|---|---|---|---|
| SAST | ESLint + `eslint-plugin-security` (todos os pacotes) | 0 após triagem | Nenhum |
| Scan de dependências | `pnpm audit` | 1 moderado | Nenhum |
| Scan de segredos | `gitleaks` v8.30.1 | 0 no histórico do git | Nenhum |

**Nenhum achado crítico ou alto existe nesta baseline.** O único achado (moderado, dependência)
está documentado abaixo com severidade, responsável e prazo, mas não bloqueia por não ser
crítico/alto.

---

## 1. SAST (Static Application Security Testing)

**Ferramenta:** ESLint com `eslint-plugin-security` (regras: `detect-unsafe-regex`,
`detect-non-literal-regexp`, `detect-object-injection`, `detect-child-process`,
`detect-eval-with-expression`, `detect-non-literal-fs-filename`, entre outras do preset
`recommended`), aplicado a `apps/api`, `apps/web` e `packages/shared`.

**Descoberta durante a execução desta task**: `packages/shared` e `apps/api` não tinham NENHUMA
configuração de ESLint (nem devDependency `eslint` instalada) — `pnpm lint` (usado pelo job
`Lint` do CI) falhava com "'eslint' não é reconhecido" antes mesmo de rodar uma regra. Só
`apps/web` tinha lint funcional (config do Next.js). Isso nunca foi pego porque nada foi
empurrado para o GitHub ainda (CI nunca rodou de verdade — ver `.planning/STATE.md`). Corrigido
como parte desta baseline: `eslint.config.mjs` criado para `apps/api` e `packages/shared`
(`typescript-eslint` + `eslint-plugin-security`), e o mesmo plugin adicionado à config existente
de `apps/web`.

**Comando:** `pnpm lint` (raiz do monorepo, executa em todos os workspaces via `pnpm -r`)

**Evidência (execução real, saída completa):**

```
$ pnpm -r --if-present lint
Scope: 3 of 4 workspace projects
packages/shared lint$ eslint "src/**/*.ts"
packages/shared lint: Done
apps/api lint$ eslint "src/**/*.ts" "test/**/*.ts"
apps/api lint: Done
apps/web lint$ eslint
apps/web lint: Done
```

**Resultado: 0 problemas em todos os pacotes**, após triagem de 1 achado e correção de 2
problemas de qualidade de código não relacionados a segurança que bloqueavam a execução limpa:

| # | Local | Regra | Severidade | Veredito | Responsável | Status |
|---|---|---|---|---|---|---|
| SAST-01 | `apps/api/src/shifts/shift-commands.service.ts:41` (`ISO_UTC_PATTERN`) | `security/detect-unsafe-regex` | Baixa (falso positivo) | **Falso positivo, triado** — regex sem quantificadores aninhados/sobrepostos (o padrão real de ReDoS, ex. `(a+)+$`); todos os grupos são de comprimento fixo (`{4}`/`{2}`) exceto `(\.\d+)?`, um único grupo opcional não repetido — pior caso é O(n), não exponencial. Suprimido com `eslint-disable-next-line` + justificativa inline no código, apontando para este relatório. | Equipe de plataforma | Fechado (documentado, sem ação necessária) |

Dois achados de qualidade (`@typescript-eslint/no-unused-vars` em código de teste, sem relação
com segurança) foram corrigidos diretamente para permitir uma execução limpa da ferramenta:
variável de teste nunca lida em `test/notifications/in-app.e2e-spec.ts`, e uma asserção vazia
(`.every(() => true)`, sempre verdadeira independente do dado) em
`test/shifts/search-shifts.e2e-spec.ts`.

---

## 2. Scan de dependências

**Ferramenta:** `pnpm audit` (consulta ao banco de advisories do npm/GitHub)

**Comando:** `pnpm audit`

**Evidência (execução real):**

```
┌─────────────────────┬────────────────────────────────────────────────────────┐
│ moderate             │ PostCSS has XSS via Unescaped </style> in its CSS      │
│                      │ Stringify Output                                       │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Package              │ postcss                                                │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Vulnerable versions  │ <8.5.10                                                │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Patched versions     │ >=8.5.10                                               │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Paths                │ apps__web>next>postcss                                 │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ More info            │ https://github.com/advisories/GHSA-qx2v-qp2m-jg93      │
└─────────────────────┴────────────────────────────────────────────────────────┘
1 vulnerabilities found
Severity: 1 moderate
```

`pnpm audit --json` confirma: `{"info":0,"low":0,"moderate":1,"high":0,"critical":0}` sobre um
total de 850 dependências (diretas + transitivas + dev + opcionais).

| # | Pacote | Severidade | CWE | Path | Responsável | Avaliação | Ação | Expiração da aceitação |
|---|---|---|---|---|---|---|---|---|
| DEP-01 | `postcss@8.4.31` | **Moderada** | CWE-79 (XSS) | `apps/web > next > postcss` (dependência interna do próprio Next.js 15.5.20, não uma dependência direta nossa) | Equipe de plataforma | A vulnerabilidade é em *stringificação* de CSS (AST → texto) com `</style>` não escapado. Neste app, PostCSS roda só em **build time**, processando CSS estático nosso (Tailwind, `globals.css`) — não há CSS dinâmico nem input de usuário passando por essa stringificação em nenhum momento do runtime. Não é uma dependência direta nossa (é interna ao bundler do Next), então não pode ser corrigida via upgrade isolado sem esperar o Next.js atualizar sua própria dependência interna. | **Aceito formalmente** (risco não aplicável ao runtime desta aplicação) | **2026-10-11** (3 meses) — reavaliar se o Next.js ainda não tiver atualizado o postcss interno; se sim, fazer upgrade do Next.js nessa data. |

Nenhum achado crítico ou alto. O único achado (moderado) tem responsável, avaliação de risco
explícita e data de expiração da aceitação, conforme exigido.

---

## 3. Scan de segredos

**Ferramenta:** `gitleaks` v8.30.1 (binário oficial, mesmo mecanismo usado pelo job
`secret-scan` do CI via `gitleaks/gitleaks-action@v2` em `.github/workflows/ci.yml`)

### 3a. Histórico do git (equivalente exato ao que roda no CI)

**Comando:** `gitleaks detect --source . --report-format json`

**Evidência (execução real):**

```
7:54AM INF 31 commits scanned.
7:54AM INF scanned ~737739 bytes (737.74 KB) in 320ms
7:54AM INF no leaks found
```

**Resultado: 0 segredos encontrados** em nenhum dos 31 commits do repositório.

### 3b. Árvore de trabalho completa (verificação extra, além do que o CI cobre)

**Comando:** `gitleaks detect --no-git --source . --report-format json` (varre todo arquivo em
disco, incluindo os não commitados e os ignorados pelo git — mais abrangente que o scan de
histórico, propositalmente, para não deixar pontos cegos)

**Evidência:** 6 achados, todos da MESMA origem:

| # | Arquivo | Regra | Natureza |
|---|---|---|---|
| SEC-01..06 | `apps/web/.next/**` (`.previewinfo`, `.rscinfo`, `prerender-manifest.json`, `server-reference-manifest.json`) | `generic-api-key` | Chaves de assinatura/criptografia do **modo preview interno do Next.js**, geradas automaticamente pelo próprio `next build` a cada execução, nunca definidas por nós |

**Veredito: falso positivo por escopo, não um segredo real.** `apps/web/.next/` é diretório de
build gerado (`.gitignore` linha 3: `.next/`) — nunca é commitado, é regenerado do zero a cada
`next build`, e as chaves ali dentro não protegem nenhum dado de produção (são específicas do
recurso de preview do Next, local a cada build). Confirmado que o scan de histórico do git (3a,
que é o que efetivamente protege o repositório) não encontrou nada — esses arquivos nunca
entraram no controle de versão.

**Nenhuma ação necessária.** Nenhum segredo real (chave de API, senha, token, credencial de
banco) foi encontrado em nenhum lugar do código ou histórico.

---

## Controles de segurança já existentes (contexto, não achados desta baseline)

Registrados aqui para dar contexto ao leitor — já implementados e testados em tasks anteriores,
não fazem parte do escopo de achados desta baseline (que é sobre SAST/dependências/segredos),
mas são relevantes para avaliar a postura geral:

- Isolamento multi-tenant via Row-Level Security do Postgres (`tenant_isolation` + políticas
  adicionais por caso de uso) — T-1.2.3/T-1.2.4.
- Role de runtime restrita (`plantoes_app`, sem `BYPASSRLS`, sem superusuário) — a aplicação
  nunca roda com privilégios de administrador do banco.
- Sessão via cookie HMAC-assinado (`HttpOnly`, `SameSite=Lax`, `Secure` fora de dev local) — sem
  token armazenado em memória compartilhada do servidor — T-1.2.1.
- RBAC com autorização sempre no servidor, nunca confiando em dado do cliente — T-1.2.2.
- Auditoria imutável a nível de banco (sem `UPDATE`/`DELETE` concedido à role de runtime) —
  T-2.2.1/T-2.2.2.
- Garantia de concorrência de aprovação de candidatura reforçada por constraint única no banco
  (não apenas checagem em código) — T-1.1.3/T-4.2.1, com correção de deadlock real encontrada e
  corrigida em T-5.2.1.
- CI já configurado com jobs de lint, typecheck, testes, build, scan de dependências e scan de
  segredos (`.github/workflows/ci.yml`) — ainda não verificado rodando de verdade porque nada
  foi empurrado para o GitHub (decisão do operador, ver `.planning/STATE.md`).

---

## Conclusão

Nenhum achado crítico ou alto em nenhuma das três verificações. Um achado moderado (dependência
transitiva do Next.js) foi formalmente aceito com justificativa de risco e data de expiração.
Um achado de SAST (regex) foi triado como falso positivo com justificativa técnica documentada
no código. Zero segredos reais encontrados. **Critério de aceite (`Nenhum achado crítico ou alto
fica sem correção ou aceite formal com expiração`) satisfeito.**
