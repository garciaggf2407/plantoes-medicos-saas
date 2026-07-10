import { Module } from "@nestjs/common";
import { ApplicationsController } from "./applications.controller";
import { ApplyToShiftUseCase } from "./apply-to-shift.use-case";
import { ReviewApplicationUseCase } from "./review-application.use-case";

@Module({
  controllers: [ApplicationsController],
  providers: [ApplyToShiftUseCase, ReviewApplicationUseCase],
  exports: [ApplyToShiftUseCase, ReviewApplicationUseCase],
})
export class ApplicationsModule {}
