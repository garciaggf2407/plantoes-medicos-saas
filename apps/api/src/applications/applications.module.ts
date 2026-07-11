import { Module } from "@nestjs/common";
import { ApplicationsController } from "./applications.controller";
import { ApplyToShiftUseCase } from "./apply-to-shift.use-case";
import { ReviewApplicationUseCase } from "./review-application.use-case";
import { ListPendingApplicationsQuery } from "./list-pending-applications.query";

@Module({
  controllers: [ApplicationsController],
  providers: [ApplyToShiftUseCase, ReviewApplicationUseCase, ListPendingApplicationsQuery],
  exports: [ApplyToShiftUseCase, ReviewApplicationUseCase],
})
export class ApplicationsModule {}
