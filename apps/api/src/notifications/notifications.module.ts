import { Global, Module } from "@nestjs/common";
import { OutboxService } from "./outbox.service";
import { NotificationWorkerService } from "./notification.worker";

@Global()
@Module({
  providers: [OutboxService, NotificationWorkerService],
  exports: [OutboxService, NotificationWorkerService],
})
export class NotificationsModule {}
