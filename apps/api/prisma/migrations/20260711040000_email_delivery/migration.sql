-- AlterTable
ALTER TABLE "users" ADD COLUMN "email_opt_out" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "email_deliveries" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source_outbox_event_id" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_deliveries_source_outbox_event_id_user_id_key" ON "email_deliveries"("source_outbox_event_id", "user_id");

-- CreateIndex
CREATE INDEX "email_deliveries_organization_id_idx" ON "email_deliveries"("organization_id");

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: mesma politica tenant_isolation das demais tabelas
-- hospitalares. Sem politica de destinatario cross-org (ao contrario
-- de notifications) porque email_deliveries e um ledger interno, sem
-- endpoint de leitura pelo usuario final nesta task.
ALTER TABLE "email_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_deliveries"
  USING (organization_id = current_setting('app.current_organization_id', true));

-- notifications.sourceOutboxEventId+userId precisa incluir channel:
-- IN_APP (InAppService, T-5.1.3) e EMAIL (EmailAdapter, T-5.1.4) do
-- MESMO evento para o MESMO destinatario nao devem colidir na mesma
-- constraint unica.
DROP INDEX "notifications_source_outbox_event_id_user_id_key";
CREATE UNIQUE INDEX "notifications_source_outbox_event_id_user_id_channel_key" ON "notifications"("source_outbox_event_id", "user_id", "channel");
