-- Role de runtime da aplicação. Deliberadamente SEM senha aqui —
-- nenhum secret aparece em código-fonte. Um operador deve definir a
-- senha fora do controle de versão:
--   ALTER ROLE plantoes_app WITH PASSWORD '<secret do ambiente>';
-- Enquanto a senha não é definida, a role existe mas não consegue
-- autenticar (fail closed).
--
-- Esta role é usada pela aplicação em runtime (DATABASE_URL). As
-- migrations continuam rodando com uma conexão privilegiada
-- (superusuário), que por padrão do Postgres ignora Row-Level
-- Security — por isso é essencial que o runtime NUNCA use essa
-- conexão privilegiada, ou as políticas de RLS criadas em
-- rls_and_constraints ficam sem efeito prático.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'plantoes_app') THEN
    CREATE ROLE plantoes_app LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO plantoes_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plantoes_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO plantoes_app;
