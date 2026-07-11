import { Global, Module } from "@nestjs/common";
import { OutboxService } from "./outbox.service";
import { NotificationWorkerService } from "./notification.worker";
import { InAppService } from "./in-app.service";
import { NotificationsController } from "./notifications.controller";

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [OutboxService, NotificationWorkerService, InAppService],
  exports: [OutboxService, NotificationWorkerService, InAppService],
})
export class NotificationsModule {}
