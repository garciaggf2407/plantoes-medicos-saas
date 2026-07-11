import { Global, Module } from "@nestjs/common";
import { OutboxService } from "./outbox.service";
import { NotificationWorkerService } from "./notification.worker";
import { InAppService } from "./in-app.service";
import { EmailAdapter } from "./email.adapter";
import { NotificationsController } from "./notifications.controller";

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [OutboxService, NotificationWorkerService, InAppService, EmailAdapter],
  exports: [OutboxService, NotificationWorkerService, InAppService, EmailAdapter],
})
export class NotificationsModule {}
