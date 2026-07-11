-- AlterTable
ALTER TABLE "notifications" ADD COLUMN "source_outbox_event_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "notifications_source_outbox_event_id_user_id_key" ON "notifications"("source_outbox_event_id", "user_id");

-- RLS: um médico recebe notificações de QUALQUER hospital que
-- publique um plantão compatível (fan-out em T-5.1.3) -- a mesma
-- limitação de "uma organização por transação" já resolvida para
-- calendário (doctor_self_calendar) e auditoria pessoal
-- (self_authored_global_log) se aplica aqui. Política adicional
-- (permissiva, combina com tenant_isolation via OR) usando
-- app.current_actor_user_id: o destinatário lê/marca como lida
-- QUALQUER notificação endereçada a ele, em qualquer organização,
-- sem conceder acesso a nenhuma linha de outro usuário nem a nenhuma
-- outra tabela. Escopo restrito a SELECT/UPDATE -- o INSERT sempre
-- acontece pelo caminho de escopo de organização (tenant_isolation),
-- nunca por este.
CREATE POLICY notification_recipient_select ON "notifications"
  FOR SELECT
  USING (user_id = current_setting('app.current_actor_user_id', true));

CREATE POLICY notification_recipient_update ON "notifications"
  FOR UPDATE
  USING (user_id = current_setting('app.current_actor_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_actor_user_id', true));
