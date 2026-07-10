import { Module } from "@nestjs/common";
import { ShiftsController } from "./shifts.controller";
import { ShiftCommandsService } from "./shift-commands.service";

@Module({
  controllers: [ShiftsController],
  providers: [ShiftCommandsService],
  exports: [ShiftCommandsService],
})
export class ShiftsModule {}
