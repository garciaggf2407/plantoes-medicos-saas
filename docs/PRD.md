# PRD — Plantões Médicos (estado atual verificado em código)

**Versão do documento:** 1.0
**Data:** 2026-07-14
**Autor:** Levantamento técnico direto do código-fonte (não de memória de sessões anteriores nem de documentação prévia)
**Natureza:** Este NÃO é um PRD prospectivo ("o que vamos construir"). É um PRD retrospectivo e descritivo: documenta o que o sistema **faz de fato hoje**, com que regras, que limites, e que buracos — para que a direção do produto possa ser avaliada contra a realidade, não contra a intenção original.
**Método:** Cada afirmação funcional abaixo foi verificada lendo o código-fonte (controllers, use-cases, schema Prisma) nesta sessão, com citação de arquivo. Nenhuma afirmação deste documento vem de suposição ou de relatórios anteriores não re-verificados.

---

## 1. Sumário Executivo

Plantões Médicos é um marketplace B2B2C multi-tenant que conecta hospitais (que publicam vagas de plantão) a médicos (que se candidatam), com uma camada de aprovação e credenciamento no meio. A arquitetura tem rigor de engenharia real — isolamento de tenant reforçado no banco (RLS), controle de concorrência explícito para evitar dupla-aprovação de plantão, padrão outbox transacional para notificações, trilha de auditoria imutável, dinheiro armazenado como inteiro (nunca float), datas sempre em UTC. Isso não é um protótipo estético: é um sistema com decisões de design defensáveis em entrevista técnica.

Ao mesmo tempo, o produto tem uma assimetria clara: **o núcleo transacional (publicar plantão → buscar → candidatar → aprovar) está completo e testado (169 testes de integração, 11 cenários E2E via navegador real). Tudo que envolve comunicação de volta ao usuário — notificar, autenticar de verdade, credenciar pela UI — está com o backend pronto e a ponta (frontend, integração externa) deliberadamente incompleta.** Isso não é acidente de implementação isolado; é um padrão que se repete em pelo menos quatro subsistemas diferentes (ver Seção 9). Vale nomear esse padrão explicitamente porque ele é o que mais define "para onde este produto está indo" hoje: é um sistema com miolo sólido e superfície de entrada/saída (login real, notificação real, credenciamento pela UI) ainda não fechada.

---

## 2. Objetivo e Problema de Negócio

Resolver a coordenação entre hospitais com vagas de plantão médico não preenchidas e médicos disponíveis, com garantias que um processo manual (WhatsApp, planilha, ligação) não oferece:

- Nenhum plantão pode ser preenchido duas vezes (garantia de banco, não de aplicação).
- Nenhum médico não credenciado por um hospital específico pode assumir um plantão daquele hospital.
- Toda decisão de aprovação/rejeição (candidatura ou credencial) é auditável e exige justificativa.
- Um hospital nunca vê ou afeta dados de outro hospital, mesmo em caso de bug de aplicação (isolamento reforçado em nível de banco, não só de query).

---

## 3. Personas e Papéis

O sistema tem exatamente três papéis (`UserRole`: `DOCTOR`, `HOSPITAL_ADMIN`, `SUPERADMIN`), sem hierarquia intermediária (não existe "médico sênior" ou "hospital com múltiplos admins de níveis diferentes" — todo `HOSPITAL_ADMIN` de uma organização tem os mesmos poderes).

### 3.1 Médico (`DOCTOR`)
Papel padrão. **Qualquer identidade nova autenticada via OIDC que não tenha sido explicitamente convidada como admin de hospital vira médico automaticamente** (`auth.service.ts:71-95`) — não existe um passo de "escolher seu papel" no cadastro real; a atribuição é automática e unidirecional. Um médico:
- Mantém um perfil (CRM, especialidades, telefone, cidade).
- Envia credencial (comprovante) a um hospital específico — **via API apenas, sem tela** (ver Seção 9, GAP-06).
- Busca plantões publicados, por cidade ou por hospital específico.
- Candidata-se a um plantão — **sem poder desistir depois** (não existe rota de cancelamento de candidatura, ver Seção 9).
- Acompanha suas candidaturas aprovadas num calendário pessoal (só suas, cross-hospital).

### 3.2 Administrador de Hospital (`HOSPITAL_ADMIN`)
Escopo estritamente limitado à própria organização (reforçado por RLS, não só por filtro de query). Nunca é auto-provisionado — é criado por um `SUPERADMIN` via `POST /organizations`, com um usuário `pending:<uuid>` que precisa reivindicar o convite depois. Um admin de hospital:
- Publica, edita e cancela plantões da própria organização.
- Revisa e aprova/rejeita credenciais de médicos que se candidataram ao seu hospital.
- Revisa e aprova/rejeita candidaturas a plantões, com justificativa obrigatória.
- Edita o perfil público do próprio hospital (cidade, endereço, descrição, foto).
- Não tem visibilidade nenhuma sobre outros hospitais.

### 3.3 Superadministrador (`SUPERADMIN`)
Papel de plataforma, não de hospital — `organizationId` sempre nulo. Por desenho explícito, **é estritamente leitura sobre dados de terceiros**: pode listar todos os hospitais e ver o detalhe operacional completo de qualquer um (perfil + plantões + candidaturas + credenciais), mas não pode editar nada em nome de um hospital. A única escrita que o superadmin faz é `POST /organizations` (provisionar um novo hospital). Toda leitura cross-tenant é registrada em log de auditoria (`organization.viewed_by_superadmin`) — o superadmin não navega "de graça", cada acesso a dados de outro tenant fica rastreado.

---

## 4. Escopo Funcional por Domínio

### 4.1 Autenticação e Identidade

**Mecanismo real de produção:** OIDC (authorization code + PKCE), verificação de token via biblioteca `jose`. **Este sistema, hoje, não tem nenhum Identity Provider real configurado neste ambiente** — o `OIDC_ISSUER_URL` está vazio. O comportamento de segurança aqui é correto e vale registrar como ponto forte: se `OIDC_ISSUER_URL` estiver vazio e a flag `ALLOW_FAKE_OIDC` não estiver explicitamente `"true"`, a aplicação **recusa subir** (`auth.module.ts:46-51`) — falha fechada, não aberta. É o oposto do erro comum de "esquecer de configurar auth e deixar tudo público por omissão".

**O que existe hoje de fato é um provedor falso (`FakeOidcProvider`)**, ativado só quando `ALLOW_FAKE_OIDC=true`, que expõe seis rotas (`/auth/dev-login`, `/dev-login/submit`, `/dev-accounts`, `/dev-quick-login`, `/dev-register/doctor`, `/dev-register/hospital`) — todas retornam 404 se a flag não estiver ativa, então não existe risco de essas rotas vazarem em um deploy configurado corretamente. As páginas `/login` e `/cadastro` do frontend (adicionadas nesta última rodada) são clientes desse provedor falso, não de um OIDC real.

**Sessão:** cookie `plantoes_session`, assinado HMAC-SHA256 com verificação por comparação de tempo constante (`timingSafeEqual`, evita timing attack), `HttpOnly`, `SameSite=Lax`, `Secure` por padrão (desligável só via env explícita), TTL configurável (padrão 1h).

**Comportamento de erro no callback:** ao invés de devolver um JSON de erro cru (comportamento antigo, corrigido nesta sessão anterior), qualquer falha no callback OIDC (código reusado, state divergente, e-mail já reivindicado por outra conta) redireciona o usuário de volta ao app com o motivo numa query string amigável, exibida pelo `AppShell`.

**Requisito implícito não documentado em lugar nenhum até este PRD:** como todo usuário novo vira `DOCTOR` automaticamente, a única forma de um hospital existir na plataforma é um `SUPERADMIN` provisioná-lo manualmente primeiro. Não existe fluxo de "hospital se cadastra sozinho e pede aprovação" em produção real (o `dev-register/hospital` é só do provedor falso).

### 4.2 Organizações (Hospitais) e Multi-tenancy

Uma `Organization` é a raiz de tenant: toda entidade hospitalar (usuários de hospital, plantões, candidaturas, credenciais, notificações, eventos de outbox, logs de auditoria) carrega `organizationId` e está sujeita a Row-Level Security no Postgres — a policy é aplicada via migração SQL complementar (o Prisma não expressa `CREATE POLICY` nativamente), então essa garantia vive fora do schema.prisma e não foi re-verificada linha a linha nesta rodada (fica como item a confirmar, não como fato assumido).

Campos do hospital: nome e timezone são obrigatórios desde a criação; cidade, endereço, descrição e foto são todos opcionais — deliberadamente, porque hospitais provisionados antes desses campos existirem não podem quebrar (comentário explícito no schema).

Provisionar um hospital (`POST /organizations`, só `SUPERADMIN`) cria, numa única transação, a `Organization` e um primeiro usuário `HOSPITAL_ADMIN` com `oidcSubject` no formato `pending:<uuid>` — ou seja, o convite existe no banco antes de a pessoa existir como identidade OIDC real; ela "reivindica" esse registro no primeiro login. O e-mail de convite propriamente dito é responsabilidade de um worker separado, não é enviado de forma síncrona pela própria requisição de provisionamento.

### 4.3 Perfil e Credenciamento do Médico

Perfil (`DoctorProfile`): CRM (obrigatório, mínimo 3 caracteres), especialidades (array, não pode ser vazio nem ter entrada em branco), telefone (opcional, validado por regex), cidade (opcional, mas se informada **precisa corresponder a uma cidade de hospital já cadastrado** — nunca texto livre, evitando "Campinas" vs "campinas" como entidades diferentes).

Credenciamento é por par médico↔hospital, não um selo global: existe no máximo uma `Credential` por combinação `(doctorProfileId, organizationId)`, com um dos quatro estados `PENDING | APPROVED | REJECTED | EXPIRED`. A máquina de estados é assimétrica de um jeito que vale registrar como decisão de produto a confirmar (ver Seção 10): `REJECTED` é terminal do ponto de vista do hospital (um admin não pode "voltar atrás" e reaprovar uma rejeição), mas o médico pode reenviar uma nova evidência a qualquer momento, e esse reenvio **reseta o registro inteiro para `PENDING`, apagando quem revisou, quando e por quê** — a justificativa da rejeição original não fica preservada em nenhum histórico. Ou seja, na prática a rejeição não é tão terminal quanto a máquina de estados sugere; ela só é irreversível pelo lado do admin, não pelo relacionamento como um todo.

### 4.4 Plantões (Shifts)

Um plantão pertence a um hospital, tem especialidade, valor em centavos (nunca float — decisão de precisão financeira explícita no schema), início e fim sempre em UTC, e um dos quatro estados `DRAFT | PUBLISHED | FILLED | CANCELLED`. As transições válidas são estritas: `DRAFT` pode virar `PUBLISHED` ou `CANCELLED`; `PUBLISHED` pode virar `FILLED` ou `CANCELLED`; os outros dois são terminais. Note que **`FILLED` nunca é uma ação direta do hospital** — só acontece como efeito colateral de uma candidatura ser aprovada. Isso é coerente com a regra de negócio (o estado reflete realidade, não intenção), mas significa que um hospital não tem como "reservar" um plantão para um médico específico sem passar pelo fluxo de candidatura.

Editar um plantão publicado que já tem alguma candidatura ativa (pendente ou aprovada) é bloqueado — o hospital precisa cancelar e recriar. Cancelar um plantão publicado com candidaturas pendentes rejeita automaticamente todas elas, na mesma transação, com justificativa registrada.

A busca (`GET /shifts/search`) sempre retorna só plantões `PUBLISHED`, com filtro por especialidade, faixa de valor, faixa de data e paginação (20 por página, teto de 50). Existem dois caminhos: busca dentro de um hospital específico (`organizationId` na query) ou busca por cidade, resolvendo todos os hospitais daquela cidade e mesclando resultados. Se nem cidade nem hospital forem informados, o sistema cai de volta na cidade salva no perfil do médico; se essa também não existir, a busca falha explicitamente (400) em vez de devolver uma lista vazia silenciosa — comportamento correto (erro visível > resultado enganoso), mas que exige da UI tratar esse caso (o `CitySelector` cobre isso hoje).

Não existe conceito de vaga múltipla: um plantão tem exatamente um médico aprovado possível (reforçado por índice único parcial no banco, não só por lógica de aplicação).

### 4.5 Candidaturas (Applications)

Uma candidatura liga um médico a um plantão, com estado `PENDING | APPROVED | REJECTED`. Existe no máximo uma candidatura por par médico↔plantão. **Não existe rota de desistência** — uma vez que o médico se candidata, ele não tem como cancelar essa candidatura pela própria conta; só o hospital, ao decidir (aprovar/rejeitar) ou ao cancelar o plantão inteiro, altera esse estado. Isso é um ponto de atrito de produto real (ver Seção 10), não um detalhe técnico menor.

O controle de concorrência na aprovação é o ponto de maior rigor técnico do sistema: ao decidir uma candidatura, a aplicação trava explicitamente a linha do **plantão** (não da candidatura) com `SELECT ... FOR UPDATE`, numa ordem deliberada para evitar deadlock entre duas revisões simultâneas do mesmo plantão. Se duas aprovações concorrentes acontecerem, a segunda, ao reler o estado após obter o lock, descobre que o plantão não está mais disponível e falha com um erro específico (`shift_not_available`); como camada extra de defesa, se ainda assim as duas tentarem gravar `APPROVED`, a constraint única do banco rejeita a segunda e a aplicação traduz isso num erro de negócio (`shift_already_filled`) em vez de vazar um erro de banco cru. Além disso, no momento da decisão (não só no momento da candidatura), o sistema reverifica conflito de agenda e validade da credencial — porque ambos podem ter mudado entre a candidatura e a revisão.

Ao aprovar uma candidatura, todas as outras candidaturas pendentes para o mesmo plantão são automaticamente rejeitadas em lote, com justificativa padrão ("Plantão preenchido por outro candidato").

### 4.6 Calendário

Existem dois calendários visuais na UI, mas só um deles é alimentado por um endpoint dedicado. O calendário do médico (`GET /calendar`) é uma rota exclusiva de `DOCTOR` — se qualquer outro papel tentar chamá-la, é barrado explicitamente — e devolve só as candidaturas **aprovadas** do próprio médico, cruzando todos os hospitais, num intervalo de datas (padrão: do mês anterior até 3 meses à frente). O calendário do hospital, por outro lado, não tem endpoint próprio: é uma construção só de frontend que reaproveita `GET /shifts` (a listagem administrativa) e filtra no cliente para mostrar só publicados/preenchidos. Os dois são estritamente somente-leitura — nenhuma ação (publicar, cancelar, candidatar) está disponível a partir da visão de calendário.

### 4.7 Notificações

Este é o subsistema com a maior distância entre "engenharia pronta" e "produto entregue". A infraestrutura é sólida: todo evento de domínio relevante é gravado numa tabela de outbox **na mesma transação** que a mudança de negócio que o originou (garantia de que evento e mutação nunca divergem, mesmo em caso de falha no meio do caminho) — mas **hoje existem exatamente dois tipos de evento registrados no sistema inteiro**: plantão publicado e candidatura decidida. Notavelmente, **revisão de credencial (aprovação ou rejeição) não dispara evento algum** — um médico credenciado ou rejeitado não gera nenhum rastro no sistema de notificação, mesmo que a infraestrutura completa exista para isso.

Um worker assíncrono (fila BullMQ, não ligado por padrão — precisa de `NOTIFICATIONS_WORKER_ENABLED=true`) consome esses eventos, com reclamo de itens travados havia mais de 5 minutos, até 5 tentativas de entrega com backoff exponencial configurável, e um estado explícito de "morto" (`DEAD_LETTER`) para eventos que esgotaram as tentativas — com uma rota dedicada (`GET /notifications/dead-letter`, só admin de hospital) para inspecionar falhas de entrega. Isso é desenho de sistema de mensageria de verdade, não um `setTimeout` com retry ingênuo.

O que efetivamente "sai" desse pipeline hoje: o provedor de e-mail configurado é `console` por padrão e **nenhum provedor real (SMTP, SES, Postgres-backed, etc.) está implementado no código** — qualquer outro valor de `EMAIL_PROVIDER` simplesmente falha ao subir. Ou seja, "envio de e-mail transacional" hoje significa "grava no log do servidor", não "chega na caixa de entrada de alguém". Existe também um modelo de notificação in-app completo no banco (lida/não lida, por canal, com API de listagem e contagem de não lidas) — mas, confirmado por busca no código do frontend inteiro, **nenhuma tela, componente ou hook consome essa API hoje**. Não existe sino, não existe lista, não existe contador visível em lugar nenhum da interface.

### 4.8 Observabilidade e Auditoria

Toda leitura ou escrita sensível (provisionamento de hospital, decisão de credencial, decisão de candidatura, leitura cross-tenant por superadmin) grava uma linha imutável em `AuditLog`, com ator, ação, alvo e justificativa quando aplicável. Não existe endpoint de update ou delete para essa tabela a nível de aplicação — é auditoria de verdade, não um log que pode ser editado depois.

A instrumentação de tracing/métricas (OpenTelemetry) é inteiramente manual e deliberadamente cirúrgica: seis pontos específicos do sistema têm span próprio (login, busca de plantão por hospital, busca por cidade, candidatura, decisão, entrega de notificação) — não existe instrumentação automática de toda requisição HTTP nem de toda query de banco. O contexto de trace é propagado manualmente até para dentro do evento de outbox, para que a entrega assíncrona de notificação apareça como filha do trace da requisição original que a originou — detalhe sofisticado, raro em projetos deste porte. Sem um endpoint OTLP configurado (não há nenhum configurado neste ambiente), tudo isso cai em exportação para console — funcional para demonstrar o desenho, não conectado a um backend de observabilidade real (Grafana, Datadog, etc.).

O endpoint `/health` existe mas hoje é decorativo: retorna `{status:"ok"}` incondicionalmente, sem checar conexão real com banco, Redis ou qualquer dependência. Num ambiente de produção real, isso permitiria um load balancer considerar a instância saudável mesmo com o banco fora do ar.

---

## 5. Modelo de Dados

Nove entidades, seis enums. Toda entidade hospitalar carrega `organizationId`.

| Entidade | Papel | Chaves/constraints notáveis |
|---|---|---|
| `Organization` | Raiz de tenant | — |
| `User` | Identidade + papel | `oidcSubject` único, `email` único, nunca armazena senha |
| `DoctorProfile` | Perfil médico (1:1 com User) | `userId` único |
| `Credential` | Vínculo médico↔hospital | único `(doctorProfileId, organizationId)` |
| `Shift` | Vaga de plantão | índices por `(org, status)` e `(org, especialidade, valor)` |
| `Application` | Candidatura | único `(shiftId, doctorProfileId)` + índice único parcial de 1 aprovação por plantão (fora do schema.prisma, em migração SQL) |
| `Notification` | Notificação in-app/email | único `(sourceOutboxEventId, userId, channel)` |
| `EmailDelivery` | Prova de entrega de e-mail | único `(sourceOutboxEventId, userId)` — existência da linha = confirmação do provedor |
| `OutboxEvent` | Fila transacional de eventos | índice `(status, availableAt)` |
| `AuditLog` | Trilha imutável | `organizationId` nulável (ações globais de superadmin) |

**Enums:** `UserRole{DOCTOR,HOSPITAL_ADMIN,SUPERADMIN}` · `CredentialStatus{PENDING,APPROVED,REJECTED,EXPIRED}` · `ShiftStatus{DRAFT,PUBLISHED,FILLED,CANCELLED}` · `ApplicationStatus{PENDING,APPROVED,REJECTED}` · `NotificationChannel{IN_APP,EMAIL}` · `OutboxEventStatus{PENDING,PROCESSING,COMPLETED,DEAD_LETTER}`.

Comentários de schema que codificam regra de negócio e vale preservar: `valueCents` "nunca float"; `startsAt/endsAt` "sempre em UTC"; `city` do médico "validada contra Organization.city, nunca texto livre"; `emailOptOut` "respeitado antes de QUALQUER envio, nunca depois"; payload de `Notification` "não deve conter PII sensível"; `AuditLog` "imutável, sem update/delete a nível de aplicação".

---

## 6. Regras de Negócio Críticas (síntese)

1. Um plantão tem no máximo um médico aprovado, garantido por constraint de banco, não só por lógica de aplicação.
2. Aprovação de candidatura é serializada por lock explícito no plantão, com ordem de lock deliberada para evitar deadlock — a segunda decisão concorrente sempre perde de forma controlada, nunca corrompe estado.
3. Validade de credencial e ausência de conflito de agenda são reverificadas no momento da decisão, não só no momento da candidatura.
4. Rejeição de credencial é terminal para o hospital, mas não para o relacionamento — o médico pode reabrir via reenvio, que apaga o histórico da rejeição anterior.
5. Todo evento de notificação é gravado atomicamente com a mutação que o origina — nunca existe um estado onde a mutação de negócio aconteceu mas o evento correspondente não foi gravado (ou vice-versa).
6. Toda ação sensível (provisionar hospital, decidir credencial, decidir candidatura, ler dados de outro tenant como superadmin) é auditada de forma imutável.
7. Um usuário novo autenticado é sempre médico; virar admin de hospital exige provisionamento prévio por um superadmin.

---

## 7. Requisitos Não-Funcionais

| Categoria | Estado atual |
|---|---|
| Isolamento multi-tenant | RLS no Postgres (política fora do schema.prisma, não re-verificada linha a linha nesta rodada) + `organizationId` em toda entidade hospitalar |
| Autenticação | OIDC real implementado e íntegro, mas sem IdP configurado neste ambiente; falha fechada por padrão |
| Sessão | Cookie assinado HMAC, comparação de tempo constante, TTL configurável |
| Auditoria | Imutável, cobre provisionamento, decisões de credencial/candidatura, leituras cross-tenant |
| Concorrência | Locks explícitos + constraints de banco como segunda linha de defesa |
| Observabilidade | Manual e cirúrgica (6 spans, 5 contadores), sem instrumentação automática, sem backend real conectado |
| Health check | Presente mas não verifica dependências reais |
| Testes | 169/169 testes de integração de API, 11/11 cenários E2E via navegador real (última rodada medida) |
| E-mail transacional | Infraestrutura completa, zero provedor real implementado (só console) |
| PII em logs | Chaves sensíveis (email, CRM, justificativa, evidência, senha, token, cookie) explicitamente removidas antes de logar |

---

## 8. Matriz de Cobertura Backend × Frontend

| Funcionalidade | Backend | Frontend | Observação |
|---|---|---|---|
| Publicar/editar/cancelar plantão | ✅ | ✅ | Sem filtro/ordenação client-side na listagem do admin |
| Buscar/candidatar-se a plantão | ✅ | ✅ | — |
| Desistir de candidatura | ❌ | ❌ | Rota não existe em lugar nenhum |
| Aprovar/rejeitar candidatura | ✅ | ✅ | — |
| Enviar credencial (CRM) a um hospital | ✅ | ❌ | GAP-06 |
| Reenviar credencial após rejeição | ✅ | ❌ | GAP-07 |
| Aprovar/rejeitar credencial | ✅ | ✅ | — |
| Login/cadastro de produção (OIDC real) | ✅ (infra) | ❌ | Sem IdP configurado; UI só cobre o provedor falso |
| Provisionar hospital | ✅ | ❌ | Só via API |
| Listar/ver detalhe de hospitais (superadmin) | ✅ | ✅ | Read-only, como desenhado |
| Editar perfil do hospital | ✅ | ✅ | — |
| Calendário do médico | ✅ | ✅ | — |
| Calendário do hospital | ⚠️ (reaproveita `/shifts`) | ✅ | Sem endpoint próprio |
| Notificação por e-mail | ✅ (infra) | N/A | Sem provedor real — vira log de console |
| Notificação in-app (sino/lista) | ✅ (API completa) | ❌ | GAP-04 |
| Notificação de decisão de credencial | ❌ | ❌ | Nem o evento é gravado — nem chega a ser um problema de frontend |

---

## 9. Débitos Técnicos, Gaps e Riscos Identificados

Nomeados com severidade e, quando aplicável, o padrão que os une.

**Padrão transversal (o mais importante deste documento):** em quatro subsistemas independentes — login, credenciamento, notificação, provisionamento — o backend está completo e testado, e a peça que falta é sempre a mesma categoria de coisa: uma superfície voltada para fora (UI, integração externa real). Isso não parece ser negligência pontual; parece refletir uma ordem de prioridade deliberada (miolo transacional primeiro, superfícies de borda depois). Vale essa leitura ser confirmada ou corrigida por quem está definindo a direção do produto (ver Seção 10).

- **GAP-06 (ALTO)** — Sem UI para o médico enviar credencial a um hospital. O endpoint existe e funciona; zero tela o chama.
- **GAP-07 (ALTO)** — Sem UI para o médico ver que foi rejeitado ou reenviar credencial. Consequência direta de GAP-06.
- **GAP-04 (MÉDIO)** — Notificação in-app com API completa (listar, marcar como lida, contagem de não lidas) e zero consumidor no frontend.
- **GAP-02 (MÉDIO, reclassificado)** — Não existe login de produção possível hoje, porque não existe IdP configurado. Isso não é "falta uma tela"; é "falta uma decisão de qual provedor OIDC usar (Google, Microsoft Entra, Auth0, um IdP próprio) e configurá-lo". A UI para consumir um OIDC real já existe (`/auth/login`, `/auth/callback`); o que falta é a integração externa, não código.
- **GAP-03 (BAIXO-MÉDIO)** — Provisionar hospital só por API. Dado que é uma ação rara (feita pelo superadmin, não pelo público), o custo de não ter tela é bem menor que os outros gaps.
- **Ausência de rota de desistência de candidatura (NOVO, MÉDIO)** — Um médico que se candidata não tem como voltar atrás. Se isso for intencional (ex.: para desencorajar candidaturas levianas), vale documentar como regra de produto; se não for, é uma lacuna funcional real.
- **Perda de histórico de rejeição de credencial no reenvio (NOVO, MÉDIO)** — O reenvio apaga `justification`/`reviewedByUserId`/`reviewedAt` da rejeição anterior. Um hospital que rejeitou um médico duas vezes pelo mesmo motivo não tem como saber que já rejeitou antes, a menos que audite `AuditLog` manualmente (que registra a ação, mas não fica exposto em nenhuma tela hoje).
- **Nenhum evento de notificação para decisão de credencial (NOVO, MÉDIO)** — Mesmo depois de GAP-06/07 serem resolvidos, um médico aprovado ou rejeitado não vai receber notificação nenhuma (nem e-mail, nem in-app), porque o evento nunca é gravado no outbox. Isso precisa entrar no escopo de qualquer blueprint que feche GAP-06/07, ou o gap "reaparece" silenciosamente depois.
- **`EMAIL_PROVIDER` sem implementação real (BAIXO enquanto o produto não vai a público, ALTO no dia em que for)** — Hoje "enviar e-mail" é logar no console. Nenhum usuário real recebe nada.
- **`/health` não verifica dependências (BAIXO enquanto local, MÉDIO em qualquer deploy real)** — Um orquestrador (Kubernetes, um load balancer) consideraria a API saudável mesmo com Postgres ou Redis fora do ar.
- **RLS não re-verificada nesta rodada (risco de verificação, não de código)** — A política vive em uma migração SQL separada do `schema.prisma`; este documento não confirmou seu conteúdo linha a linha. Recomendo uma verificação dedicada antes de tratar isolamento de tenant como fato assumido em qualquer discussão de segurança.

---

## 10. Pontos em Aberto — Decisões que Precisam de Você

Isto não é um relatório de bugs; são lugares onde o sistema faz uma escolha implícita que só quem define o produto pode confirmar como certa ou errada.

1. **A ordem de prioridade "miolo antes da borda" foi deliberada?** Se sim, o próximo passo natural é fechar as quatro pontas (login real, credenciamento, notificação, provisionamento por UI) na ordem de impacto ao usuário final — não necessariamente a ordem em que foram descobertas.
2. **Desistência de candidatura: ausência intencional ou esquecimento?** Um médico que muda de ideia hoje fica sem alternativa — só o hospital pode alterar o estado da candidatura dele.
3. **O reenvio de credencial deveria preservar histórico de rejeições anteriores?** Hoje ele apaga. Se credenciamento vai ser um processo com múltiplas tentativas na prática (plausível — documentos incorretos, fotos ruins), um histórico visível ao hospital evitaria repetir a mesma rejeição sem contexto.
4. **Qual provedor OIDC real será usado?** Essa é a decisão que desbloqueia GAP-02 de verdade — sem ela, qualquer trabalho de UI de login "de produção" fica sem onde plugar.
5. **Notificação por e-mail é necessária para o MVP, ou in-app basta por enquanto?** Isso muda se vale investir em configurar um provedor real agora ou adiar.

---

## 11. Métricas Atuais do Sistema

- Testes de integração de API: 169/169 (última medição registrada em `EXECUTION-REPORT.md`).
- Cenários E2E via navegador real (Playwright): 11/11.
- Módulos de domínio no backend: 9 (`identity`, `organizations`, `credentials`, `shifts`, `applications`, `calendar`, `notifications`, `observability`, `prisma`).
- Entidades de dados: 9 modelos, 6 enums.
- Papéis de usuário: 3, sem hierarquia intermediária.

---

## 12. Apêndice — Rotas HTTP Completas

**Auth:** `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` (públicas) · `GET /me`, `PATCH /me/email-preferences` (3 papéis) · `GET|POST /auth/dev-*` (6 rotas, só com provedor falso ativo)

**Organizations:** `POST /organizations` (SUPERADMIN) · `GET /organizations` (SUPERADMIN) · `GET|PATCH /organizations/me` (HOSPITAL_ADMIN) · `GET /organizations/:id/detail` (SUPERADMIN) · `GET /cities` (3 papéis)

**Credentials:** `GET|PUT /doctors/me/profile` (DOCTOR) · `POST /doctors/me/credentials` (DOCTOR) · `GET /credentials/pending` (HOSPITAL_ADMIN) · `GET /credentials/:id` (DOCTOR, HOSPITAL_ADMIN) · `POST /credentials/:id/review` (HOSPITAL_ADMIN)

**Shifts:** `GET /shifts` (HOSPITAL_ADMIN) · `GET /shifts/search` (DOCTOR, HOSPITAL_ADMIN) · `GET /shifts/:id` (DOCTOR, HOSPITAL_ADMIN) · `POST /shifts`, `PATCH /shifts/:id`, `POST /shifts/:id/publish`, `POST /shifts/:id/cancel` (HOSPITAL_ADMIN)

**Applications:** `POST /applications` (DOCTOR) · `GET /applications/pending` (HOSPITAL_ADMIN) · `POST /applications/:id/review` (HOSPITAL_ADMIN)

**Calendar:** `GET /calendar` (DOCTOR)

**Notifications:** `GET /notifications`, `POST /notifications/:id/read` (usuário autenticado) · `GET /notifications/dead-letter` (HOSPITAL_ADMIN)

**Health:** `GET /health` (público, sem verificação de dependência)

---

*Documento gerado por levantamento técnico direto do código-fonte, não de documentação ou memória de sessões anteriores. Toda afirmação é rastreável a um arquivo específico do repositório no momento da escrita (2026-07-14).*
