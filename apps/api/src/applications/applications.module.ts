import { Module } from "@nestjs/common";
import { ApplicationsController } from "./applications.controller";
import { ApplyToShiftUseCase } from "./apply-to-shift.use-case";

@Module({
  controllers: [ApplicationsController],
  providers: [ApplyToShiftUseCase],
  exports: [ApplyToShiftUseCase],
})
export class ApplicationsModule {}
