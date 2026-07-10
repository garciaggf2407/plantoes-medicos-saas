-- Permite registrar auditoria de ações pessoais sem hospital
-- associado (ex.: médico altera o próprio perfil), sem afrouxar o
-- isolamento por tenant das demais linhas.
--
-- Postgres combina múltiplas políticas permissivas do mesmo comando
-- com OR: um INSERT em audit_logs passa se satisfizer
-- tenant_isolation (organization_id = tenant corrente) OU esta nova
-- política (organization_id nulo E o ator é exatamente o usuário
-- autenticado da sessão). Nenhuma linha com organization_id de
-- verdade pode ser inserida por esta política — ela só libera o
-- caso explicitamente sem tenant.
-- FOR ALL (não apenas INSERT): o próprio autor também precisa ler de
-- volta o que registrou (ex.: histórico do próprio perfil).
CREATE POLICY self_authored_global_log ON "audit_logs"
  FOR ALL
  USING (
    organization_id IS NULL
    AND actor_user_id = current_setting('app.current_actor_user_id', true)
  )
  WITH CHECK (
    organization_id IS NULL
    AND actor_user_id = current_setting('app.current_actor_user_id', true)
  );
