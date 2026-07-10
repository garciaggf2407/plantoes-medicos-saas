-- Auditoria imutável, aplicada no banco (não apenas por convenção de
-- não expor endpoint de update/delete): a role de runtime da
-- aplicação perde privilégio de UPDATE e DELETE em audit_logs,
-- mantendo apenas SELECT e INSERT. Nem um bug futuro na aplicação
-- consegue alterar ou apagar uma linha de auditoria já gravada.
REVOKE UPDATE, DELETE ON "audit_logs" FROM plantoes_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE UPDATE, DELETE ON TABLES FROM plantoes_app;
