-- Row-Level Security por organization_id (defesa em profundidade contra
-- vazamento cross-tenant, complementar ao middleware de tenant obrigatório
-- da camada de aplicação — ver T-1.2.3).
--
-- Aplicada apenas às tabelas de dados hospitalares propriamente ditos
-- (credentials, shifts, applications, notifications, audit_logs).
-- "users" e "doctor_profiles" não recebem RLS aqui: a identidade do
-- médico não pertence a um hospital específico (organization_id em
-- "users" identifica apenas o hospital administrado por um
-- hospital_admin, não um dado hospitalar em si).
--
-- Políticas usam a variável de sessão app.current_organization_id,
-- que a aplicação DEVE definir via `SET LOCAL` no início de cada
-- transação/requisição autenticada (nunca a partir de input do
-- cliente). Roles com BYPASSRLS (ex.: role usada por migrations e
-- por ferramentas administrativas de superadmin) ignoram estas
-- políticas por definição do Postgres.

ALTER TABLE "credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credentials" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "credentials"
  USING (organization_id = current_setting('app.current_organization_id', true));

ALTER TABLE "shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shifts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shifts"
  USING (organization_id = current_setting('app.current_organization_id', true));

ALTER TABLE "applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "applications" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "applications"
  USING (organization_id = current_setting('app.current_organization_id', true));

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notifications"
  USING (organization_id = current_setting('app.current_organization_id', true));

-- audit_logs.organization_id pode ser nulo (ações globais de
-- superadmin); sob a policy abaixo essas linhas só ficam visíveis a
-- conexões BYPASSRLS, nunca a uma sessão de tenant comum.
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_logs"
  USING (organization_id = current_setting('app.current_organization_id', true));

-- Garantia de banco (não apenas de aplicação): um plantão nunca pode
-- ter duas candidaturas aprovadas simultaneamente. Índice único
-- parcial — não expressável em schema.prisma, por isso é SQL puro.
CREATE UNIQUE INDEX "applications_one_approved_per_shift"
  ON "applications" ("shift_id")
  WHERE "status" = 'APPROVED';
